import type { AgentJournalSnapshot } from '../../../shared/agent-session-journal-types'
import type { Baseline } from './structured-agent-session-request-failure-observation'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

/** An issued result borrows the live fold until its read completes or its lifetime is revoked. */
export class ReleasedFailureRead {
  private disposition: 'live' | 'retiring' | 'completed' | 'cancelled' = 'live'
  private admitted = false
  private readonly completion = Promise.withResolvers<AgentJournalSnapshot | null>()

  constructor(
    private readonly journal: AgentSessionJournal,
    private readonly current: () => boolean,
    private readonly finished: (retiring: boolean) => void
  ) {
    void this.completion.promise.catch((error: unknown) => {
      console.warn('[native-chat] released failure read failed', error)
    })
  }

  get retiring(): boolean {
    return this.disposition === 'retiring'
  }

  retire = (): (() => void) => {
    if (this.disposition === 'live') {
      this.disposition = 'retiring'
      // A later cleanup hook may throw before close reaches its seal callback.
      queueMicrotask(() => {
        void this.read()
      })
    }
    return () => {
      void this.read()
    }
  }

  cancel = (): void => {
    if (this.disposition === 'completed' || this.disposition === 'cancelled') {
      return
    }
    const retiring = this.retiring
    this.disposition = 'cancelled'
    this.completion.resolve(null)
    this.finished(retiring)
  }

  read = (): Promise<AgentJournalSnapshot | null> => {
    if (!this.admitted && this.disposition !== 'cancelled' && this.disposition !== 'completed') {
      this.admitted = true
      try {
        void this.journal
          .readInOrder(() => {
            if (this.disposition === 'cancelled' || !this.current()) {
              this.cancel()
              return
            }
            const snapshot = this.journal.snapshot()
            const retiring = this.retiring
            this.disposition = 'completed'
            this.completion.resolve(snapshot)
            this.finished(retiring)
          })
          .catch(this.failed)
      } catch (error) {
        this.failed(error)
      }
    }
    return this.completion.promise
  }

  private failed = (error: unknown): void => {
    if (this.disposition === 'completed' || this.disposition === 'cancelled') {
      return
    }
    const retiring = this.retiring
    this.disposition = 'completed'
    this.completion.reject(error)
    this.finished(retiring)
  }
}

function releasedFailureRead(
  baselines: Map<string, Baseline>,
  sessionId: string,
  baseline: Baseline
): ReleasedFailureRead {
  if (!baseline.releasedRead) {
    const currentSource = baseline.journal.captureReadSource()
    const read = new ReleasedFailureRead(
      baseline.journal,
      () => baselines.get(sessionId) === baseline && currentSource(),
      (retiring) => {
        if (baseline.releasedRead !== read) {
          return
        }
        baseline.releasedRead = undefined
        if (retiring && baselines.get(sessionId) === baseline) {
          baselines.delete(sessionId)
        }
      }
    )
    baseline.releasedRead = read
  }
  return baseline.releasedRead
}

export function requestFailureReader(
  baselines: Map<string, Baseline>,
  sessionId: string,
  baseline: Baseline,
  released: boolean
): () => Promise<AgentJournalSnapshot | null> {
  if (released) {
    return releasedFailureRead(baselines, sessionId, baseline).read
  }
  const { journal, epoch } = baseline
  return () =>
    journal.readInOrder(() =>
      baselines.get(sessionId) === baseline &&
      !baseline.releasedRead?.retiring &&
      journal.epoch === epoch
        ? journal.snapshot()
        : null
    )
}

export function forgetRequestFailureBaseline(
  baselines: Map<string, Baseline>,
  sessionId: string,
  disposition: 'abandon' | 'retire'
): (() => void) | undefined {
  const baseline = baselines.get(sessionId)
  if (disposition === 'retire' && baseline?.releasedRead) {
    baseline.marks.clear()
    baseline.deferred = undefined
    return baseline.releasedRead.retire()
  }
  baseline?.releasedRead?.cancel()
  baselines.delete(sessionId)
  return undefined
}
