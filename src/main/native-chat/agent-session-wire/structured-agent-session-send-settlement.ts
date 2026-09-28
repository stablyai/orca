import type {
  AgentJournalCursor,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionSendResult } from '../../../shared/agent-session-wire'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

/** What a settlement read needs of a journal. */
type SendSettlementJournal = Pick<AgentSessionJournal, 'submissions' | 'cursor'>

type SettledSend = {
  cursor: AgentJournalCursor
  value: AgentSessionSendResult
}

type SendSettlement = SettledSend | 'pending' | 'missing'

/** What ends a wait: the provider's answer, or only the host handing the message over. */
export type SendSettlementPoint = 'answered' | 'handed-over'

export type SendSettlementWaitOptions = {
  signal?: AbortSignal
  /** How long to observe; unanswered by then resolves undefined. */
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
/** Long enough for a cold provider start; a longer one replays through the same wait. */
export const STRUCTURED_AGENT_SESSION_START_WAIT_MS = 120_000
const MAX_SEND_SETTLEMENT_WAITERS_PER_SESSION = 64
const MAX_SEND_SETTLEMENT_WAITERS = 1_024

function settledSend(
  journal: SendSettlementJournal,
  clientMessageId: string,
  until: SendSettlementPoint,
  submission: AgentJournalSubmission | undefined = journal
    .submissions()
    .find((candidate) => candidate.clientMessageId === clientMessageId)
): SendSettlement {
  if (!submission) {
    return 'missing'
  }
  const waiting =
    until === 'handed-over'
      ? isQueuedAgentJournalSubmission(submission)
      : submission.dispatchState === 'pending'
  return waiting ? 'pending' : { cursor: journal.cursor(), value: { clientMessageId, submission } }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('agent session send settlement wait aborted')
}

/** Best-effort settlement observation for clients that predate admitted pending replies. */
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
    const immediate = settledSend(this.journalFor(sessionId), clientMessageId, until)
    if (immediate === 'missing') {
      return Promise.reject(new Error('agent session send disappeared before settlement'))
    }
    if (immediate !== 'pending') {
      return Promise.resolve(immediate)
    }
    const existingSession = this.waiters.get(sessionId)
    if (
      this.waiterCount >= MAX_SEND_SETTLEMENT_WAITERS ||
      (existingSession?.size ?? 0) >= MAX_SEND_SETTLEMENT_WAITERS_PER_SESSION
    ) {
      return Promise.resolve(undefined)
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
    const submissions = new Map(
      journal.submissions().map((submission) => [submission.clientMessageId, submission])
    )
    for (const waiter of waiters) {
      const result = settledSend(
        journal,
        waiter.clientMessageId,
        waiter.until,
        submissions.get(waiter.clientMessageId)
      )
      if (result !== 'pending') {
        this.remove(sessionId, waiter)
        if (result === 'missing') {
          waiter.reject(new Error('agent session send disappeared before settlement'))
        } else {
          waiter.resolve(result)
        }
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
