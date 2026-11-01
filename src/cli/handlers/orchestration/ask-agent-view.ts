import { renderCommand } from '../../orchestration-mutation-recovery'
import { resolveOrchestrationCliExecutable } from '../../runtime/orchestration-recovery-command'
import type { LegacyCompatibilityResult } from '../../../shared/orchestration-check-output'
import type { OrchestrationAgentView } from './agent-view'
import { withReceiptNext } from './receipt-next-text'

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

type AskFields = {
  answer?: string
  messageId: string | null
  threadId?: string
  pending?: true
  timedOut?: true
  timeoutMs?: number
  cancelled?: true
  connectionLost?: true
  next?: string
}

export function askView(args: {
  from: string | undefined
  dispatchCapability: string | undefined
  timeoutMs: number
}): OrchestrationAgentView<AskResult, AskFields> {
  // Report the server's effective budget, which may be clamped below the requested timeout.
  const waitedMs = (value: AskResult): number => value.timeoutMs ?? args.timeoutMs
  const resumeCommand = (value: AskResult): string | undefined =>
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
          String(waitedMs(value))
        ])
      : undefined
  return {
    fields: (value) => {
      const resume = resumeCommand(value)
      return {
        answer: value.answer ?? undefined,
        messageId: value.messageId,
        threadId: value.threadId && value.threadId !== value.messageId ? value.threadId : undefined,
        pending: value.pending ? true : undefined,
        timedOut: value.timedOut ? true : undefined,
        timeoutMs: value.timedOut ? waitedMs(value) : undefined,
        cancelled: value.cancelled ? true : undefined,
        connectionLost: value.connectionLost ? true : undefined,
        next: resume
          ? `Resume waiting; do not ask again: ${resume}`
          : value.legacyCompatibility?.resumeRequired
            ? `Resume with: ${value.legacyCompatibility.resumeCommand}`
            : value.next
      }
    },
    text: (fields, value) =>
      fields.answer ?? withReceiptNext(askStatusLine(value, waitedMs(value)), fields),
    failure: (value) => {
      if (value.legacyCompatibility?.resumeRequired) {
        return {
          code: 'ask_resume_required',
          message: `Question ${value.messageId} was committed; resume it to wait for the answer.`,
          exitCode: 75
        }
      }
      if (value.timedOut) {
        const resume = resumeCommand(value)
        return {
          code: 'ask_timeout',
          message: resume
            ? `ask timeout after ${waitedMs(value)}ms; question ${value.messageId} is still pending. Resume waiting; do not ask again: ${resume}`
            : `ask timeout after ${waitedMs(value)}ms; question identity was not returned, so it cannot be resumed safely.`
        }
      }
      return value.cancelled
        ? {
            code: value.connectionLost ? 'ask_connection_closed' : 'ask_cancelled',
            message: `ask ${value.connectionLost ? 'connection closed' : 'cancelled'} (question ${value.messageId})`
          }
        : undefined
    }
  }
}

function askStatusLine(value: AskResult, waitedMs: number): string {
  if (value.pending) {
    return `Question ${value.messageId} sent.`
  }
  if (value.legacyCompatibility?.resumeRequired) {
    return `Question ${value.messageId} committed.`
  }
  if (value.timedOut) {
    return `Question ${value.messageId ?? '(unknown id)'} is still pending after ${waitedMs}ms.`
  }
  return `Wait for question ${value.messageId} ${value.connectionLost ? 'lost its connection' : 'was cancelled'}.`
}
