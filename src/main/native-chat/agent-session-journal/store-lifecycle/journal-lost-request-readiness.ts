import type { JournalStoreHost } from './journal-store-collaborators'
import type { JournalRowWriter } from '../writing/journal-row-writer'
import type { JournalRestoreEvidence } from '../replay/journal-restore-evidence'
import { restoreJournal } from '../replay/journal-open'
import { failLoadOnUnloadableJournal } from '../replay/journal-open-failure'
import { journalOutcomeSource } from '../outcomes/journal-outcome-format'
import { recoverLostJournalRequests } from './journal-lost-request-recovery'

type Expected = NonNullable<Parameters<typeof recoverLostJournalRequests>[3]>
type Pending = { evidence: JournalRestoreEvidence; expected: Expected }

/** Failed optional reads renew on demand; only a relevant pending proof retains raw evidence. */
export class JournalLostRequestRecovery {
  private pending: Pending | undefined
  private active: Promise<boolean> | undefined
  private identity: string | null = null
  private readonly abort = new AbortController()

  constructor(
    private readonly host: JournalStoreHost,
    private readonly writer: JournalRowWriter
  ) {}

  async restore(evidence: JournalRestoreEvidence | undefined): Promise<void> {
    if ((await this.inspect(evidence)) === 'needs-history') {
      void this.ready()
    }
  }

  ready(signal?: AbortSignal): Promise<boolean> {
    if (this.abort.signal.aborted || signal?.aborted) {
      return Promise.resolve(false)
    }
    if (!this.pending && this.identity !== null && this.identity === this.currentIdentity()) {
      return Promise.resolve(true)
    }
    this.active ??= this.attempt().finally(() => {
      this.active = undefined
    })
    return signal ? waitForProof(this.active, signal) : this.active
  }

  close(): void {
    this.abort.abort()
    this.pending = undefined
  }

  private currentIdentity(): string | null {
    return this.host.database().history?.sourceIdentity(this.host.identity.sessionId) ?? null
  }

  private relevant(pending: Pending): boolean {
    const state = this.host.state()
    return (
      state.epoch === pending.expected.epoch &&
      state.contextBoundary === pending.expected.boundary &&
      [...pending.expected.revisions].some(([id, revision]) => {
        const item = state.items.get(id)
        return (
          item?.revision === revision &&
          (item.body.kind === 'question' || item.body.kind === 'approval') &&
          item.body.resolution.state === 'cancelled'
        )
      })
    )
  }

  private async inspect(
    evidence: JournalRestoreEvidence | undefined
  ): ReturnType<typeof recoverLostJournalRequests> {
    this.identity = null
    this.pending = undefined
    if (!evidence) {
      return 'complete'
    }
    const state = this.host.state()
    const pending = {
      evidence,
      expected: {
        epoch: state.epoch,
        boundary: state.contextBoundary,
        source: journalOutcomeSource(this.host.database().db, state.sessionId, state.epoch),
        revisions: new Map(
          [...state.items]
            .filter(
              ([, item]) =>
                (item.body.kind === 'question' || item.body.kind === 'approval') &&
                item.body.resolution.state === 'cancelled'
            )
            .map(([id, item]) => [id, item.revision])
        )
      }
    }
    const result = await recoverLostJournalRequests(this.host, this.writer, evidence)
    if (result === 'complete') {
      this.identity = evidence.sourceIdentity
    } else {
      this.pending = pending
    }
    return result
  }

  private recollect(): Promise<JournalRestoreEvidence | undefined> {
    return this.host.serialize(() => {
      if (this.abort.signal.aborted) {
        return undefined
      }
      const loaded = restoreJournal(this.host.database().db, this.host.identity.sessionId, true)
      if (!loaded) {
        return undefined
      }
      failLoadOnUnloadableJournal(this.host.identity.sessionId, loaded)
      this.host.adopt(loaded)
      return loaded.recovery
    })
  }

  private async attempt(): Promise<boolean> {
    try {
      let pending = this.pending
      if (pending && !this.relevant(pending)) {
        this.pending = undefined
        return true
      }
      if (!pending || pending.evidence.sourceIdentity !== this.currentIdentity()) {
        const evidence = await this.recollect()
        if (!evidence || this.abort.signal.aborted) {
          return false
        }
        if (pending) {
          if (!this.relevant(pending)) {
            this.pending = undefined
            return true
          }
          pending.evidence = evidence
        } else {
          const result = await this.inspect(evidence)
          if (result === 'unavailable') {
            return false
          }
          pending = this.pending
          if (!pending) {
            return true
          }
        }
      }
      // The admitted raw fold is already the proof collector; only item discovery is missing.
      const ready = await this.host
        .database()
        .history?.prepareRequests(this.host.identity.sessionId, this.abort.signal)
      if (!ready || this.abort.signal.aborted) {
        return false
      }
      const result = await recoverLostJournalRequests(
        this.host,
        this.writer,
        pending.evidence,
        pending.expected
      )
      if (result !== 'complete') {
        return false
      }
      this.identity = pending.evidence.sourceIdentity
      if (this.pending === pending) {
        this.pending = undefined
      }
      return true
    } catch {
      return false
    }
  }
}

function waitForProof(proof: Promise<boolean>, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const abort = () => resolve(false)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) {
      abort()
    }
    void proof.then(resolve).finally(() => signal.removeEventListener('abort', abort))
  })
}
