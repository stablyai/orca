// Apply a model through the agent's own model command, which resolves the roles and selectors
// its model option refuses (OMP: `/model` shares `--model`'s resolver; the option takes listed ids).

import type { AcpModelCommandReply } from './acp-dialects/acp-dialect'
import { boundAcpOptionWrite, type AcpOptionWriteBound } from './acp-session-option-write'
import type { AcpSessionEvent } from './acp-session-runtime'
import type { AcpStructuredOptions } from './acp-structured-options'
import type { AcpStructuredSession } from './acp-structured-session'
import {
  ACP_OPTION_WRITE_TIMEOUT_MS,
  type AcpStructuredSessionAdapterDeps
} from './acp-structured-session-adapter-deps'

export class AcpModelCommandRefusedError extends Error {
  constructor(readonly reply: Extract<AcpModelCommandReply, { refused: string }>) {
    super(reply.detail)
    this.name = 'AcpModelCommandRefusedError'
  }
}

export async function applyAcpModelCommand(
  session: Pick<AcpStructuredSession, 'spec' | 'connection' | 'options' | 'turns'>,
  value: string,
  bound: AcpOptionWriteBound
): Promise<void> {
  const command = session.spec.dialect.modelCommand
  if (!command) {
    throw new Error(`${bound.agent} has no model command`)
  }
  // The command is a prompt, so a steer still interrupts the running answer before it is sent.
  if (session.turns.running) {
    session.turns.interruptForPermissionTransition()
    await session.turns.whenIdle(bound.signal)
  }
  const { options } = session
  await boundAcpOptionWrite(options, { ...bound, key: 'model', value }, async () => {
    options.commandReply = ''
    try {
      const result = await session.connection.prompt([{ type: 'text', text: command.text(value) }])
      const reply = command.reply(options.commandReply)
      // Only a normally ended command that reports its model counts; anything else leaves it unapplied.
      if (result.stopReason !== 'end_turn' || !('applied' in reply)) {
        throw new AcpModelCommandRefusedError(
          'refused' in reply ? reply : { refused: 'modelUnavailable', detail: result.stopReason }
        )
      }
      const { applied } = reply
      return () => applied
    } finally {
      options.commandReply = null
    }
  })
}

/** Option writes and the model command share one deadline, and an unanswered one retires the child. */
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

export function acpModelCommandFor(
  session: Parameters<typeof applyAcpModelCommand>[0],
  bound: AcpOptionWriteBound
): ((value: string) => Promise<void>) | undefined {
  return session.spec.dialect.modelCommand
    ? (value) => applyAcpModelCommand(session, value, bound)
    : undefined
}

/** True when the event is the hidden model command's output, which the chat must not show. */
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
