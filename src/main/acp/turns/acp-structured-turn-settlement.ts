import {
  agentSessionFailureFact,
  type SubmissionRejectionFact
} from '../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'
import type { StructuredAgentSessionCommandRun } from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import { GENERIC_ACP_DIALECT } from '../acp-dialects/acp-dialect'
import type { ContentBlock, PromptResponse } from '../generated/acp-protocol.generated'
import { AcpAuthRequiredError, type AcpAgentError } from '../transport/acp-errors'
import { acpCompactPrompt } from './acp-compaction-turn'
import { acpPromptErrorDetail, acpPromptRejection } from './acp-prompt-failure'
import type { AcpStructuredTurnsDeps } from './acp-turn-dispatch-contract'

export type AcpTurnSend = { clientMessageId: string; prompt: ContentBlock[]; requestedAt: number }

export type AcpInFlightTurn = {
  send: AcpTurnSend
  /** Written to the wire; prevents a concurrent steer from overtaking the active prompt. */
  sent: boolean
  /** Buffered if a concurrent steer settles before the active prompt yields. */
  settled?: { ok: true; result: PromptResponse } | { ok: false; error: unknown }
}

export const ACP_PROVIDER_EXITED_FACT = agentSessionFailureFact('providerExited')
export const ACP_WITHDRAWN_STEER_FACT = agentSessionFailureFact('cancelled', {
  neverReachedAgent: true
})

export class AcpTurnIdleWaiters {
  private readonly waiters = new Set<() => void>()

  wait(running: boolean, signal?: AbortSignal): Promise<void> {
    if (!running || signal?.aborted) {
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      const wake = (): void => {
        this.waiters.delete(wake)
        signal?.removeEventListener('abort', wake)
        resolve()
      }
      this.waiters.add(wake)
      signal?.addEventListener('abort', wake, { once: true })
    })
  }

  notify(): void {
    for (const wake of this.waiters) {
      wake()
    }
    this.waiters.clear()
  }
}

export function interruptAcpUnpromptedTurn(
  deps: Pick<AcpStructuredTurnsDeps, 'connection' | 'lane' | 'withdrawRequests'>
): void {
  if (deps.lane.openTurnId !== null && !deps.lane.agentTurn.endUnasked()) {
    deps.withdrawRequests()
    void deps.connection.cancel().catch(() => undefined)
    deps.lane.agentTurn.end('cancelled')
  }
}

export async function runAcpCompactTurn(
  deps: Pick<AcpStructuredTurnsDeps, 'agentName' | 'dialect' | 'lane' | 'now'>,
  command: StructuredAgentSessionCommandRun,
  isBusy: () => boolean,
  begin: (send: AcpTurnSend, promptId: string) => void
): Promise<void> {
  if (isBusy()) {
    throw new Error(`${deps.agentName} is still working`)
  }
  const { lane } = deps
  const agentTurn = lane.openTurnId
  // A backed-up journal admits the agent turn's end later; adopt the command after it.
  if (lane.agentTurn.end() && agentTurn !== null) {
    await lane.whenTurnLeaves(agentTurn)
    if (isBusy()) {
      throw new Error(`${deps.agentName} is still working`)
    }
  }
  const send: AcpTurnSend = {
    clientMessageId: command.clientMessageId,
    prompt: acpCompactPrompt(command.instructions, deps.dialect?.compactCommand),
    requestedAt: deps.now()
  }
  lane.beginCommand(command)
  try {
    const opened = lane.translator.openPrompt(
      send.clientMessageId,
      send.requestedAt,
      command.turnId
    )
    begin(send, opened.promptId)
  } catch (error) {
    lane.forgetCommand(command.turnId)
    throw error
  }
}

export function rejectAcpTurnSend(
  deps: Pick<AcpStructuredTurnsDeps, 'agentName' | 'settle'>,
  unsettled: Set<string>,
  clientMessageId: string,
  fact: SubmissionRejectionFact
): void {
  if (!unsettled.delete(clientMessageId)) {
    return
  }
  deps.settle({
    clientMessageId,
    state: 'rejected',
    ...agentSessionFailureWords(fact, { surface: 'rejection', agentName: deps.agentName })
  })
}

export function rejectAcpQueuedSends(
  deps: Pick<AcpStructuredTurnsDeps, 'agentName' | 'settle'>,
  unsettled: Set<string>,
  sends: readonly AcpTurnSend[],
  fact: SubmissionRejectionFact
): void {
  for (const send of sends) {
    rejectAcpTurnSend(deps, unsettled, send.clientMessageId, fact)
  }
}

export function rejectAcpPreOpenSend(
  deps: Pick<AcpStructuredTurnsDeps, 'agentName' | 'dialect' | 'lane' | 'modelRefusal' | 'settle'>,
  unsettled: Set<string>,
  clientMessageId: string,
  error: AcpAgentError
): void {
  const detail = acpPromptErrorDetail(deps.dialect ?? GENERIC_ACP_DIALECT, error)
  const signedOut = deps.lane.translator.authenticationRequired(error)
  const noModel = deps.modelRefusal?.(error)
  rejectAcpTurnSend(
    deps,
    unsettled,
    clientMessageId,
    acpPromptRejection(detail, signedOut, noModel)
  )
}

export function settleAcpActiveAgentFailure(
  deps: Pick<AcpStructuredTurnsDeps, 'agentName' | 'lane' | 'modelRefusal' | 'now' | 'settle'>,
  unsettled: Set<string>,
  clientMessageId: string,
  error: AcpAgentError
): Error | undefined {
  const { lane } = deps
  const refusal = lane.translator.promptRefused(clientMessageId, error)
  // Also retires the proof of a model the agent turned out not to have.
  const noModel = deps.modelRefusal?.(error)
  if (refusal !== null) {
    const signedOut = lane.translator.authenticationRequired(error)
    rejectAcpTurnSend(
      deps,
      unsettled,
      clientMessageId,
      acpPromptRejection(refusal, signedOut, noModel)
    )
  } else {
    lane.apply(lane.translator.promptFailed(clientMessageId, error, deps.now()))
  }
  return lane.translator.sessionLost(error) ? error : undefined
}

export function settleAcpUnexpectedError(
  deps: Pick<AcpStructuredTurnsDeps, 'lane' | 'now'>,
  clientMessageId: string,
  error: unknown
): void {
  const cause = error instanceof Error ? error : new Error(String(error))
  deps.lane.apply(deps.lane.translator.promptFailed(clientMessageId, cause, deps.now()))
}

export function settleAcpEndedTurns(
  deps: Pick<
    AcpStructuredTurnsDeps,
    'agentName' | 'dialect' | 'lane' | 'modelRefusal' | 'now' | 'settle'
  >,
  unsettled: Set<string>,
  inFlight: { active: AcpInFlightTurn | null; steering: AcpInFlightTurn | null },
  reason: string,
  cause: Error | undefined
): void {
  const entries = [
    ...(inFlight.active ? [{ send: inFlight.active.send, opened: true }] : []),
    ...(inFlight.steering ? [{ send: inFlight.steering.send, opened: false }] : [])
  ]
  for (const { send, opened } of entries) {
    if (cause instanceof AcpAuthRequiredError) {
      if (opened) {
        settleAcpActiveAgentFailure(deps, unsettled, send.clientMessageId, cause)
      } else {
        rejectAcpPreOpenSend(deps, unsettled, send.clientMessageId, cause)
      }
    } else if (unsettled.delete(send.clientMessageId)) {
      deps.settle({ clientMessageId: send.clientMessageId, state: 'unknown', reason })
    }
  }
}
