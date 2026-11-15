import { queuedSendAnswer } from './structured-agent-session-queued-send-answer'
import type { JournalWorkReader } from '../../agent-session-journal/journal-work-read'
import type {
  SqlAgentSessionJournal,
  SqlAgentSessionJournal as AgentSessionJournal
} from '../../agent-session-journal/journal-sql-store'
import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentSessionSendResult } from '../../../../shared/agent-session/agent-session-wire'
import { isQueuedAgentJournalSubmission } from '../../../../shared/agent-session/requests/agent-session-queued-submission'
import { isStructuredAgentSessionCommandTurnId } from '../operations/structured-agent-session-command-turn'

/** Scope active turns to the live generation so ended commands cannot hold delivery waits. */
export type SendSettlementJournal = Pick<AgentSessionJournal['reads'], 'submission' | 'cursor'> & {
  attemptEnded?: (clientMessageId: string) => boolean | Promise<boolean>
  activeTurnId: () => string | null | Promise<string | null>
  queuedSend?: (
    clientMessageId: string
  ) => AgentSessionSendResult | null | Promise<AgentSessionSendResult | null>
}

type SettledSend = {
  cursor: AgentJournalCursor
  value: AgentSessionSendResult
}

type SendSettlement = SettledSend | 'pending' | 'missing'

export type SendSettlementPoint = 'answered' | 'handed-over' | 'handed-over-or-behind-command'

export type SendSettlementWaitOptions = {
  signal?: AbortSignal
  budgetMs?: number
  until?: SendSettlementPoint
}

type SendSettlementWaiter = {
  clientMessageId: string
  until: SendSettlementPoint
  resolve: (result: SettledSend | undefined) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  onAbort?: () => void
}

// Known legacy clients abandon the RPC after 15s without cancelling its socket dispatch.
const SEND_SETTLEMENT_WAIT_TIMEOUT_MS = 30_000
/** Longer cold starts retry through the same wait. */
export const STRUCTURED_AGENT_SESSION_START_WAIT_MS = 120_000
const MAX_SEND_SETTLEMENT_WAITERS_PER_SESSION = 64
const MAX_SEND_SETTLEMENT_WAITERS = 1_024

async function settledSend(
  journal: SendSettlementJournal,
  clientMessageId: string,
  until: SendSettlementPoint
): Promise<SendSettlement> {
  const row = await journal.queuedSend?.(clientMessageId)
  if (row && 'queued' in row) {
    return row.queued.state === 'withdrawn' ||
      row.queued.state === 'returned' ||
      (until === 'handed-over-or-behind-command' && (await runningCommand(journal)))
      ? { cursor: await journal.cursor(), value: row }
      : 'pending'
  }
  const submission =
    row && 'submission' in row ? row.submission : await journal.submission(clientMessageId)
  if (!submission) {
    return 'missing'
  }
  const ended =
    submission.dispatchState === 'pending' &&
    (await journal.attemptEnded?.(submission.clientMessageId))
  const observed = ended ? { ...submission, dispatchState: 'unknown' as const } : submission
  const waiting =
    until === 'answered'
      ? submission.dispatchState === 'pending' && !ended
      : isQueuedAgentJournalSubmission(submission) &&
        !(until === 'handed-over-or-behind-command' && (await runningCommand(journal)))
  return waiting
    ? 'pending'
    : { cursor: await journal.cursor(), value: { clientMessageId, submission: observed } }
}

async function runningCommand(journal: SendSettlementJournal): Promise<boolean> {
  const turnId = await journal.activeTurnId()
  return turnId !== null && isStructuredAgentSessionCommandTurnId(turnId)
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('agent session send settlement wait aborted')
}

export class StructuredAgentSessionSendSettlement {
  private readonly waiters = new Map<string, Set<SendSettlementWaiter>>()
  private waiterCount = 0

  constructor(private readonly journalFor: (sessionId: string) => SendSettlementJournal) {}

  wait = (
    sessionId: string,
    clientMessageId: string,
    options: SendSettlementWaitOptions = {}
  ): Promise<SettledSend | undefined> => {
    const { signal } = options
    const until = options.until ?? 'answered'
    if (signal?.aborted) {
      return Promise.reject(abortError(signal))
    }
    const journal = this.journalFor(sessionId)
    const existingSession = this.waiters.get(sessionId)
    if (
      this.waiterCount >= MAX_SEND_SETTLEMENT_WAITERS ||
      (existingSession?.size ?? 0) >= MAX_SEND_SETTLEMENT_WAITERS_PER_SESSION
    ) {
      return settledSend(journal, clientMessageId, until).then((result) => {
        if (result === 'missing') {
          throw new Error('agent session send disappeared before settlement')
        }
        return result === 'pending' ? undefined : result
      })
    }
    return new Promise((resolve, reject) => {
      const waiter: SendSettlementWaiter = {
        clientMessageId,
        until,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.remove(sessionId, waiter)
          resolve(undefined)
        }, options.budgetMs ?? SEND_SETTLEMENT_WAIT_TIMEOUT_MS)
      }
      waiter.timer.unref?.()
      const session = existingSession ?? new Set<SendSettlementWaiter>()
      session.add(waiter)
      this.waiters.set(sessionId, session)
      this.waiterCount += 1
      // Register before reading so a publication during the read cannot be lost.
      void this.settle(sessionId, waiter, journal)
      if (signal) {
        const onAbort = (): void => {
          this.remove(sessionId, waiter)
          reject(abortError(signal))
        }
        waiter.signal = signal
        waiter.onAbort = onAbort
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) {
          onAbort()
        }
      }
    })
  }

  publish(sessionId: string, journal: SendSettlementJournal): void {
    const waiters = this.waiters.get(sessionId)
    if (!waiters) {
      return
    }
    for (const waiter of waiters) {
      void this.settle(sessionId, waiter, journal)
    }
  }

  private async settle(
    sessionId: string,
    waiter: SendSettlementWaiter,
    journal: SendSettlementJournal
  ): Promise<void> {
    try {
      const result = await settledSend(journal, waiter.clientMessageId, waiter.until)
      if (result === 'pending' || !this.waiters.get(sessionId)?.has(waiter)) {
        return
      }
      this.remove(sessionId, waiter)
      if (result === 'missing') {
        waiter.reject(new Error('agent session send disappeared before settlement'))
      } else {
        waiter.resolve(result)
      }
    } catch (error) {
      if (this.waiters.get(sessionId)?.has(waiter)) {
        this.remove(sessionId, waiter)
        waiter.reject(error instanceof Error ? error : new Error(String(error)))
      }
    }
  }

  closeSession(sessionId: string): void {
    const waiters = this.waiters.get(sessionId)
    if (!waiters) {
      return
    }
    for (const waiter of waiters) {
      this.remove(sessionId, waiter)
      waiter.resolve(undefined)
    }
  }

  closeAll(): void {
    for (const sessionId of this.waiters.keys()) {
      this.closeSession(sessionId)
    }
  }

  private remove(sessionId: string, waiter: SendSettlementWaiter): void {
    clearTimeout(waiter.timer)
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort)
    }
    const session = this.waiters.get(sessionId)
    if (session?.delete(waiter)) {
      this.waiterCount -= 1
    }
    if (session?.size === 0) {
      this.waiters.delete(sessionId)
    }
  }
}

/** Canonical attempt-end evidence completes unanswered waits without changing delivery truth. */
export function sendSettlementReading(
  journal: AgentSessionJournal | SqlAgentSessionJournal,
  readWork: JournalWorkReader
): SendSettlementJournal {
  return {
    submission: (id) => journal.reads.submission(id),
    attemptEnded: async (id) =>
      (await readWork({ kind: 'attempt-ended', clientMessageId: id })).ended,
    cursor: () => journal.reads.cursor(),
    activeTurnId: async () => (await readWork({ kind: 'turn' })).activeTurn?.turnId ?? null,
    queuedSend: (id) => queuedSendAnswer(journal, id)
  }
}
