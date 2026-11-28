import type { SubmissionRejectionFact } from '../../../shared/agent-session/failures/agent-session-failure'
import type { StructuredAgentSessionCommandRun } from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import { GENERIC_ACP_DIALECT } from '../acp-dialects/acp-dialect'
import type { PromptResponse } from '../generated/acp-protocol.generated'
import { AcpAuthRequiredError, type AcpAgentError } from '../transport/acp-errors'
import { acpCompactPrompt } from './acp-compaction-turn'
import { acpPromptErrorDetail, acpPromptRejection } from './acp-prompt-failure'
import type { AcpStructuredTurnsDeps, AcpTurnSend } from './acp-turn-dispatch-contract'

export type AcpInFlightTurn = {
  send: AcpTurnSend
  /** Written to the wire; prevents a concurrent steer from overtaking the active prompt. */
  sent: boolean
  /** Buffered if a concurrent steer settles before the active prompt yields. */
  settled?: { ok: true; result: PromptResponse } | { ok: false; error: unknown }
}

export type AcpTurnSettlementSink = {
  accept: (clientMessageId: string) => void
  reject: (clientMessageId: string, fact: SubmissionRejectionFact) => void
  unknown: (clientMessageId: string, reason: string) => void
}

export function openAcpPromptTurn(
  lane: AcpStructuredTurnsDeps['lane'],
  send: AcpTurnSend
): { promptId: string } {
  lane.agentTurn.end()
  const opened = lane.translator.openPrompt(send.clientMessageId, send.requestedAt)
  lane.apply(opened.events)
  return opened
}

export function sendAcpTurnPrompt(
  deps: Pick<AcpStructuredTurnsDeps, 'connection' | 'lane'>,
  entry: AcpInFlightTurn,
  promptId: string,
  handlers: {
    onResult: (result: PromptResponse) => void
    onError: (error: unknown) => void
  },
  earlier?: Promise<PromptResponse>
): void {
  const meta = deps.lane.translator.injectsPromptIdentity
    ? { promptId, requestId: promptId }
    : undefined
  let settled = false
  const onResult = (result: PromptResponse): void => {
    if (settled) {
      return
    }
    settled = true
    handlers.onResult(result)
  }
  const onError = (error: unknown): void => {
    if (settled) {
      return
    }
    settled = true
    handlers.onError(error)
  }
  // Handle replies synchronously so steering settles and promotes in wire frame order.
  const answered = earlier ?? deps.connection.prompt(entry.send.prompt, meta, onResult, onError)
  entry.sent = true
  answered.then(onResult, onError)
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
  deps: Pick<AcpStructuredTurnsDeps, 'agentName' | 'compactCommand' | 'dialect' | 'lane' | 'now'>,
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
    prompt: acpCompactPrompt(
      command.instructions,
      deps.compactCommand ?? deps.dialect?.compactCommand
    ),
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

export function rejectAcpPreOpenSend(
  deps: Pick<AcpStructuredTurnsDeps, 'dialect' | 'lane' | 'modelRefusal'>,
  sink: Pick<AcpTurnSettlementSink, 'reject'>,
  clientMessageId: string,
  error: AcpAgentError
): void {
  const detail = acpPromptErrorDetail(deps.dialect ?? GENERIC_ACP_DIALECT, error)
  const signedOut = deps.lane.translator.authenticationRequired(error)
  const noModel = deps.modelRefusal?.(error)
  sink.reject(clientMessageId, acpPromptRejection(detail, signedOut, noModel))
}

export function settleAcpActiveAgentFailure(
  deps: Pick<AcpStructuredTurnsDeps, 'lane' | 'modelRefusal' | 'now'>,
  sink: Pick<AcpTurnSettlementSink, 'accept' | 'reject'>,
  send: AcpTurnSend,
  error: AcpAgentError
): Error | undefined {
  const { lane } = deps
  const refusal = lane.translator.promptRefused(send.clientMessageId, error)
  // Also retires the proof of a model the agent turned out not to have.
  const noModel = deps.modelRefusal?.(error)
  if (refusal !== null) {
    const signedOut = lane.translator.authenticationRequired(error)
    sink.reject(send.clientMessageId, acpPromptRejection(refusal, signedOut, noModel))
  } else {
    lane.apply(lane.translator.promptFailed(send.clientMessageId, error, deps.now()))
    if (send.adopted) {
      sink.accept(send.clientMessageId)
    }
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
  deps: Pick<AcpStructuredTurnsDeps, 'dialect' | 'lane' | 'modelRefusal' | 'now'>,
  sink: AcpTurnSettlementSink,
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
        settleAcpActiveAgentFailure(deps, sink, send, cause)
      } else {
        rejectAcpPreOpenSend(deps, sink, send.clientMessageId, cause)
      }
    } else {
      sink.unknown(send.clientMessageId, reason)
    }
  }
}
