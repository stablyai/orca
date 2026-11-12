// Apply a model through the agent's own model command, which resolves the roles and selectors
// its model option refuses (OMP: `/model` shares `--model`'s resolver; the option takes listed ids).

import {
  agentSessionFailureFact,
  providerDiagnostic,
  type SubmissionRejectionFact
} from '../../../shared/agent-session/failures/agent-session-failure'
import { acpPromptErrorDetail } from './acp-prompt-failure'
import type { AcpAgentError } from '../transport/acp-errors'
import { acpAgentName } from '../session/acp-structured-agent-definitions'
import { AgentSessionOptionRejectedError } from '../../native-chat/agent-session-wire/options/structured-agent-session-option-error'
import type { AcpModelCommandReply } from '../acp-dialects/acp-dialect'
import { boundAcpOptionWrite, type AcpOptionWriteBound } from '../options/acp-session-option-write'
import type { AcpSessionEvent } from '../protocol/acp-session-events'
import type { AcpStructuredOptions } from '../options/acp-structured-options'
import type { AcpStructuredSession } from '../session/acp-structured-session-contract'
import {
  ACP_OPTION_WRITE_TIMEOUT_MS,
  type AcpStructuredSessionAdapterDeps
} from '../session/acp-structured-session-adapter-deps'

export class AcpModelCommandRefusedError extends Error {
  constructor(readonly reply: Extract<AcpModelCommandReply, { refused: string }>) {
    super(reply.detail)
    this.name = 'AcpModelCommandRefusedError'
  }
}

type AcpModelCommandSession = Pick<
  AcpStructuredSession,
  'spec' | 'connection' | 'options' | 'turns'
>

async function applyAcpModelCommand(
  session: AcpModelCommandSession,
  value: string,
  bound: AcpOptionWriteBound,
  throwIfWithdrawn: () => void
): Promise<void> {
  const command = session.spec.dialect.modelCommand
  if (!command) {
    throw new Error(`${bound.agent} has no model command`)
  }
  // The command is a prompt, so a steer still interrupts the running answer before it is sent.
  if (session.turns.running) {
    await session.turns.whenIdle(bound.signal)
  }
  throwIfWithdrawn()
  const { options } = session
  await boundAcpOptionWrite(options, { ...bound, key: 'model', value }, async () => {
    options.commandReply = ''
    try {
      const result = await session.connection.prompt([{ type: 'text', text: command.text(value) }])
      const reply = command.reply(options.commandReply)
      // Only a normally ended command that reports its model counts; anything else leaves it unapplied.
      if (result.stopReason !== 'end_turn') {
        throw new AgentSessionOptionRejectedError(
          `${bound.agent} model command ended ${result.stopReason}`,
          'optionRejected',
          agentSessionFailureFact('cancelled', { neverReachedAgent: true })
        )
      }
      if (!('applied' in reply)) {
        // A Stop it already reached outranks the agent's refusal: the message was never sent.
        throwIfWithdrawn()
        throw new AcpModelCommandRefusedError(reply)
      }
      const { applied } = reply
      return () => applied
    } finally {
      options.commandReply = null
    }
  })
}

/** Option writes and the model command share one deadline; only an unanswered command, a hidden
 *  prompt Orca cannot cancel, retires the child. */
export function acpOptionWriteBound(
  deps: Pick<AcpStructuredSessionAdapterDeps, 'optionWriteTimeoutMs'>,
  session: Pick<AcpStructuredSession, 'spec'>,
  signal: AbortSignal | undefined,
  onUncertain: (error: Error) => void
): AcpOptionWriteBound {
  return {
    agent: session.spec.agent,
    timeoutMs: deps.optionWriteTimeoutMs ?? ACP_OPTION_WRITE_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
    onUncertain
  }
}

type AcpModelFallback = ReturnType<typeof acpModelFallback>

/** A send that falls back to the agent's model command is a held steer from then until it is
 *  admitted: a Stop or teardown since its option writes began withdraws it, unsent. Sends that never
 *  fall back keep their usual Stop rules. */
export async function withAcpModelFallback<T>(
  session: AcpModelCommandSession,
  bound: AcpOptionWriteBound,
  prepare: (fallback: AcpModelFallback) => Promise<T>
): Promise<T> {
  const fallback = acpModelFallback(session, bound)
  try {
    return await prepare(fallback)
  } finally {
    fallback.release()
  }
}

function acpModelFallback(session: AcpModelCommandSession, bound: AcpOptionWriteBound) {
  const epoch = session.turns.withdrawalEpoch
  let release: (() => void) | null = null
  const throwIfWithdrawn = (): void => {
    const withdrawn = session.turns.withdrawnSince(epoch)
    if (withdrawn) {
      throw acpWithdrawnSteer(acpAgentName(session.spec.agent), withdrawn === 'ended')
    }
  }
  const done = (): void => {
    release?.()
    release = null
  }
  return {
    hold: (): void => {
      release ??= session.turns.holdSteer()
    },
    command: session.spec.dialect.modelCommand
      ? async (value: string): Promise<void> => {
          release ??= session.turns.holdSteer()
          await applyAcpModelCommand(session, value, bound, throwIfWithdrawn)
        }
      : undefined,
    /** Checks in the admission step itself, which may wait before committing. */
    admitting: (commit: () => void) => (): void => {
      if (release) {
        throwIfWithdrawn()
      }
      // Admitted, it is an ordinary steer; still held, it would cancel itself as it starts.
      done()
      commit()
    },
    release: done
  }
}

/** True when the event is a hidden option command's output, which the chat must not show. */
export function absorbsAcpModelCommandOutput(
  options: AcpStructuredOptions,
  event: AcpSessionEvent
): boolean {
  if (options.commandReply === null) {
    return false
  }
  const update = event.kind === 'known' ? event.notification.update : undefined
  if (update?.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
    options.commandReply += update.content.text
  }
  return (
    update?.sessionUpdate !== 'config_option_update' &&
    update?.sessionUpdate !== 'available_commands_update'
  )
}

/** OMP says "No model selected" whether a launch selector never resolved or it lacks a sign-in,
 *  so the refusal states only that; the next send applies the chat's selection again. */
export function acpNoModelSelected(
  dialect: AcpStructuredSession['spec']['dialect'],
  options: AcpStructuredOptions,
  error: AcpAgentError
): SubmissionRejectionFact | undefined {
  if (!dialect.modelCommand?.noModel(error)) {
    return undefined
  }
  options.invalidateInput('model')
  return agentSessionFailureFact('modelNotSelected', {
    detail: providerDiagnostic(acpPromptErrorDetail(dialect, error), 'log')
  })
}

/** A role steer a Stop or teardown reached while it prepared: it never reached the agent. */
export function acpWithdrawnSteer(agentName: string, ended: boolean): Error {
  return new AgentSessionOptionRejectedError(
    `${agentName} stopped before this message was sent`,
    'optionRejected',
    agentSessionFailureFact(ended ? 'providerExited' : 'cancelled', { neverReachedAgent: true })
  )
}
