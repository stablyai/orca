import { renderCommand } from '../../orchestration-mutation-recovery'
import type { RuntimeClient, RuntimeRpcSuccess } from '../../runtime-client'
import { resolveOrchestrationCliExecutable } from '../../runtime/orchestration-recovery-command'
import type { LegacyCompatibilityResult } from '../../../shared/orchestration-check-output'
import {
  printOrchestrationFields,
  reportOrchestrationFailure,
  resolveOrcaCommandsInText
} from './agent-view'
import { withReceiptNext } from './receipt-next-text'
import { flushOrchestrationStdout } from './runtime-compatibility'

export type AskResult = {
  answer: string | null
  messageId: string | null
  threadId: string
  timedOut: boolean
  timeoutMs?: number
  cancelled?: boolean
  connectionLost?: boolean
  answerMessageId?: string | null
  pending?: boolean
  next?: string
  legacyCompatibility?: LegacyCompatibilityResult
}

export async function printConciseAskResult(
  result: RuntimeRpcSuccess<AskResult>,
  args: {
    client: RuntimeClient
    json: boolean
    from: string | undefined
    dispatchCapability: string | undefined
    timeoutMs: number
  }
): Promise<void> {
  const value = result.result
  // Report the server's effective budget, which may be clamped below the requested timeout.
  const waitedMs = value.timeoutMs ?? args.timeoutMs
  const resumeCommand =
    value.timedOut && value.messageId !== null
      ? renderCommand([
          resolveOrchestrationCliExecutable(),
          'orchestration',
          'ask',
          // A session's resume is flagless: its injected id names it again.
          ...(args.from ? ['--from', args.from] : []),
          ...(args.dispatchCapability ? ['--dispatch-capability', args.dispatchCapability] : []),
          '--resume',
          value.messageId,
          '--timeout-ms',
          String(waitedMs)
        ])
      : undefined
  const fields = {
    ...(value.answer !== null ? { answer: value.answer } : {}),
    messageId: value.messageId,
    ...(value.threadId && value.threadId !== value.messageId ? { threadId: value.threadId } : {}),
    ...(value.pending ? { pending: true } : {}),
    ...(value.timedOut ? { timedOut: true, timeoutMs: waitedMs } : {}),
    ...(value.cancelled ? { cancelled: true } : {}),
    ...(value.connectionLost ? { connectionLost: true } : {}),
    next: resumeCommand
      ? `Resume waiting; do not ask again: ${resumeCommand}`
      : value.legacyCompatibility?.resumeRequired
        ? `Resume with: ${value.legacyCompatibility.resumeCommand}`
        : value.next && resolveOrcaCommandsInText(value.next)
  }
  printOrchestrationFields(
    args.json,
    fields,
    (shown) =>
      shown.answer !== undefined
        ? shown.answer
        : withReceiptNext(
            value.pending
              ? `Question ${shown.messageId} sent.`
              : value.legacyCompatibility?.resumeRequired
                ? `Question ${shown.messageId} committed.`
                : value.timedOut
                  ? `Question ${shown.messageId ?? '(unknown id)'} is still pending after ${waitedMs}ms.`
                  : `Wait for question ${shown.messageId} ${value.connectionLost ? 'lost its connection' : 'was cancelled'}.`,
            shown
          ),
    !value.timedOut && !value.cancelled && !value.legacyCompatibility?.resumeRequired
  )
  if (value.legacyCompatibility?.resumeRequired) {
    await flushOrchestrationStdout()
    reportOrchestrationFailure({
      code: 'ask_resume_required',
      message: `Question ${value.messageId} was committed; resume it to wait for the answer.`,
      exitCode: 75
    })
    return
  }
  const answerAck = value.legacyCompatibility?.answerAcknowledgement
  if (answerAck && value.answer !== null) {
    await flushOrchestrationStdout()
    await args.client.call('orchestration.check', {
      terminal: args.from,
      compatibilityQuestionAck: JSON.stringify(answerAck)
    })
  }
  if (value.timedOut) {
    reportOrchestrationFailure({
      code: 'ask_timeout',
      message: resumeCommand
        ? `ask timeout after ${waitedMs}ms; question ${value.messageId} is still pending. Resume waiting; do not ask again: ${resumeCommand}`
        : `ask timeout after ${waitedMs}ms; question identity was not returned, so it cannot be resumed safely.`
    })
  } else if (value.cancelled) {
    reportOrchestrationFailure({
      code: value.connectionLost ? 'ask_connection_closed' : 'ask_cancelled',
      message: `ask ${value.connectionLost ? 'connection closed' : 'cancelled'} (question ${value.messageId})`
    })
  }
}
