import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type { AgentSessionSendResult } from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

type SettledSend = {
  cursor: AgentJournalCursor
  value: AgentSessionSendResult
}

type SendSettlement = SettledSend | 'pending' | 'missing'

type SendSettlementWaiter = {
  clientMessageId: string
  resolve: (result: SettledSend) => void
  reject: (error: Error) => void
  signal?: AbortSignal
  onAbort?: () => void
}

function settledSend(
  journal: AgentSessionJournal,
  clientMessageId: string,
  submission: AgentJournalSubmission | undefined = journal
    .submissions()
    .find((candidate) => candidate.clientMessageId === clientMessageId)
): SendSettlement {
  if (!submission) {
    return 'missing'
  }
  return submission.dispatchState === 'pending'
    ? 'pending'
    : { cursor: journal.cursor(), value: { clientMessageId, submission } }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('agent session send settlement wait aborted')
}

/** Preserves the pre-pending RPC contract for older clients without holding the mutation queue. */
export class StructuredAgentSessionSendSettlement {
  private readonly waiters = new Map<string, Set<SendSettlementWaiter>>()

  constructor(private readonly journalFor: (sessionId: string) => AgentSessionJournal) {}

  wait = (
    sessionId: string,
    clientMessageId: string,
    signal?: AbortSignal
  ): Promise<SettledSend> => {
    if (signal?.aborted) {
      return Promise.reject(abortError(signal))
    }
    const immediate = settledSend(this.journalFor(sessionId), clientMessageId)
    if (immediate === 'missing') {
      return Promise.reject(new Error('agent session send disappeared before settlement'))
    }
    if (immediate !== 'pending') {
      return Promise.resolve(immediate)
    }
    return new Promise((resolve, reject) => {
      const waiter: SendSettlementWaiter = {
        clientMessageId,
        resolve,
        reject
      }
      const session = this.waiters.get(sessionId) ?? new Set<SendSettlementWaiter>()
      session.add(waiter)
      this.waiters.set(sessionId, session)
      if (signal) {
        const onAbort = (): void => {
          this.remove(sessionId, waiter)
          reject(abortError(signal))
        }
        waiter.signal = signal
        waiter.onAbort = onAbort
        signal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }

  publish(sessionId: string, journal: AgentSessionJournal): void {
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
      waiter.reject(new Error('agent session closed before send settlement'))
    }
  }

  closeAll(): void {
    for (const sessionId of this.waiters.keys()) {
      this.closeSession(sessionId)
    }
  }

  private remove(sessionId: string, waiter: SendSettlementWaiter): void {
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort)
    }
    const session = this.waiters.get(sessionId)
    session?.delete(waiter)
    if (session?.size === 0) {
      this.waiters.delete(sessionId)
    }
  }
}
