import { copyJournalWorkAuthority } from '../../agent-session-journal/journal-observer-read'
import type { SqlAgentSessionJournal } from '../../agent-session-journal/journal-sql-store'
import type {
  JournalWorkAuthority,
  JournalObserverResult
} from '../../agent-session-journal/journal-observer-read'
import type { HostUsageLimitCut } from '../recovery/structured-agent-session-usage-limit-chain'
import { sameJournalCursor } from '../../agent-session-journal/replay/journal-cursor'
export type StructuredAgentSessionStatusState = JournalObserverResult['state']

export type StructuredAgentSessionJournalProjection = {
  epoch: string
  contextId: string | null
  sequence: number
  lastActivityAt: number
  fence: number | undefined
  /** Live authority may change without a journal row. */
  liveFence: number | null
  /** Include observed row-free/lease-free child endings in cache identity. */
  workRevision: number
  /** Stop settlement edges write no row and need an independent cache key. */
  stopRevision: number
  usageLimitCut: HostUsageLimitCut | null
  state: StructuredAgentSessionStatusState
  acceptedSendKey: string
  firstInputSubmissionKey: string | null
  submissionCount: number
  stopping: boolean
  authority?: JournalWorkAuthority
  work?: JournalObserverResult['work']
}

export class StructuredAgentSessionJournalProjections {
  // Key by journal lifetime; task-progress frames must not rescan unchanged conversations.
  private readonly byJournal = new WeakMap<
    SqlAgentSessionJournal,
    StructuredAgentSessionJournalProjection
  >()

  /** Discard an invalidated asynchronous answer before touching the existing publication cache. */
  async readSql(
    journal: SqlAgentSessionJournal,
    capture: () => { authority: JournalWorkAuthority; contextId: string | null } | null,
    invalidated: () => void,
    observed?: (projection: StructuredAgentSessionJournalProjection) => void
  ): Promise<StructuredAgentSessionJournalProjection | null> {
    const captured = capture()
    if (!captured) {
      if (!journal.isClosed) {
        invalidated()
      }
      return null
    }
    const contextId = captured.contextId
    const authority = copyJournalWorkAuthority(captured.authority)
    const signature = JSON.stringify(authority)
    const cursor = journal.cursor()
    const prior = this.byJournal.get(journal)
    if (
      !journal.isClosed &&
      prior?.authority &&
      sameJournalCursor(prior, cursor) &&
      prior.contextId === contextId &&
      JSON.stringify(prior.authority) === signature
    ) {
      observed?.(prior)
      return prior
    }
    const sameContext =
      prior?.epoch === cursor.epoch && prior.contextId === contextId ? prior : undefined
    const result = await journal.reads.observer({
      authority,
      start: sameContext?.submissionCount ?? 0,
      floor: sameContext ? 0 : undefined,
      firstInputSubmissionKey: sameContext?.firstInputSubmissionKey ?? null
    })
    const current = capture()
    if (
      !current ||
      journal.isClosed ||
      !sameJournalCursor(result.cursor, journal.cursor()) ||
      !sameJournalCursor(result.physicalCursor, journal.physicalCursor()) ||
      authority.handle !== journal.observationHandle() ||
      !sameJournalCursor(authority.openedThrough, journal.openingCursor()) ||
      current.contextId !== contextId ||
      JSON.stringify(copyJournalWorkAuthority(current.authority)) !== signature ||
      JSON.stringify(result.authority) !== signature
    ) {
      invalidated()
      return null
    }
    const projection: StructuredAgentSessionJournalProjection = {
      ...result.cursor,
      lastActivityAt: result.lastActivityAt,
      contextId,
      fence: authority.record?.currentFence,
      liveFence: result.work.liveFence,
      workRevision: authority.operationalRevision,
      stopRevision: authority.stopRevision,
      usageLimitCut: result.usageLimitCut,
      state: result.state,
      ...result.indicators,
      authority,
      work: result.work
    }
    this.byJournal.set(journal, projection)
    observed?.(projection)
    return projection
  }
}
