import {
  copyJournalWorkAuthority,
  copyJournalCurrentWorkAuthority
} from '../../agent-session-journal/journal-observer-read'
import { journalSqlWorkAnswerIsCurrent } from '../../agent-session-journal/journal-sql-work-answer'
import type { JournalSqlWorkResult } from '../../agent-session-journal/journal-work-read'
import type { SqlAgentSessionJournal } from '../../agent-session-journal/journal-sql-store'
import type {
  JournalWorkAuthority,
  JournalObserverResult
} from '../../agent-session-journal/journal-observer-read'
import type { HostUsageLimitCut } from '../recovery/structured-agent-session-usage-limit-chain'
import { sameJournalCursor } from '../../agent-session-journal/replay/journal-cursor'
import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalLatestStop } from '../../agent-session-journal/context-epochs/journal-stop-turn-end'
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

type ProjectionEntry =
  | {
      kind: 'full'
      projection: StructuredAgentSessionJournalProjection
      physicalCursor: AgentJournalCursor
      savedStop: JournalLatestStop | null
    }
  | { kind: 'work-only'; answer: JournalSqlWorkResult; contextId: string | null }

type PendingObservation = { key: string; result: Promise<JournalObserverResult> }
type CapturedWork = { authority: JournalWorkAuthority; contextId: string | null }

export class StructuredAgentSessionJournalProjections {
  // Key by journal lifetime; task-progress frames must not rescan unchanged conversations.
  private readonly byJournal = new WeakMap<SqlAgentSessionJournal, ProjectionEntry>()
  private readonly pending = new WeakMap<SqlAgentSessionJournal, PendingObservation>()

  savedStop(
    journal: SqlAgentSessionJournal,
    contextId: string | null
  ): { value: JournalLatestStop | null } | undefined {
    const entry = this.currentEntry(journal)
    return entry?.kind === 'full' && entry.projection.contextId === contextId
      ? { value: entry.savedStop }
      : undefined
  }

  private currentEntry(journal: SqlAgentSessionJournal): ProjectionEntry | undefined {
    const entry = this.byJournal.get(journal)
    const projection = entry?.kind === 'full' ? entry.projection : entry?.answer.cursor
    const authority = entry?.kind === 'full' ? entry.projection.authority : entry?.answer.authority
    const physicalCursor =
      entry?.kind === 'full' ? entry.physicalCursor : entry?.answer.physicalCursor
    return entry &&
      authority &&
      projection &&
      physicalCursor &&
      !journal.isClosed &&
      sameJournalCursor(projection, journal.cursor()) &&
      sameJournalCursor(physicalCursor, journal.physicalCursor()) &&
      authority.handle === journal.observationHandle() &&
      sameJournalCursor(authority.openedThrough, journal.openingCursor())
      ? entry
      : undefined
  }

  currentSql(
    journal: SqlAgentSessionJournal,
    captured: CapturedWork | null
  ): StructuredAgentSessionJournalProjection | null {
    const entry = this.currentEntry(journal)
    const prior = entry?.kind === 'full' ? entry.projection : undefined
    return captured &&
      prior?.authority &&
      prior.contextId === captured.contextId &&
      JSON.stringify(prior.authority) ===
        JSON.stringify(copyJournalWorkAuthority(captured.authority))
      ? prior
      : null
  }

  /** Narrow work and full status occupy the same validated per-journal entry. */
  async readWorkSql(journal: SqlAgentSessionJournal, capture: () => CapturedWork | null) {
    for (;;) {
      const captured = capture()
      if (!captured) {
        this.byJournal.delete(journal)
        return null
      }
      const authority = copyJournalCurrentWorkAuthority(captured.authority)
      const entry = this.currentEntry(journal)
      const answer: JournalSqlWorkResult | undefined =
        entry?.kind === 'work-only'
          ? entry.contextId === captured.contextId
            ? entry.answer
            : undefined
          : entry?.projection.work &&
              entry.projection.contextId === captured.contextId &&
              entry.projection.authority
            ? {
                cursor: { epoch: entry.projection.epoch, sequence: entry.projection.sequence },
                physicalCursor: entry.physicalCursor,
                authority: copyJournalCurrentWorkAuthority(entry.projection.authority),
                result: { kind: 'state', state: entry.projection.work }
              }
            : undefined
      if (
        answer &&
        journalSqlWorkAnswerIsCurrent(journal, () => captured.authority, authority, answer)
      ) {
        return answer
      }
      const result = await journal.reads.work({ authority, operation: { kind: 'state' } })
      const recaptured = capture()
      if (!recaptured) {
        this.byJournal.delete(journal)
        return null
      }
      if (
        recaptured.contextId !== captured.contextId ||
        !journalSqlWorkAnswerIsCurrent(journal, () => recaptured.authority, authority, result)
      ) {
        continue
      }
      if (!this.currentSql(journal, recaptured)) {
        this.byJournal.set(journal, {
          kind: 'work-only',
          answer: result,
          contextId: captured.contextId
        })
      }
      return result
    }
  }

  /** Discard an invalidated asynchronous answer before touching the existing publication cache. */
  async readSql(
    journal: SqlAgentSessionJournal,
    capture: () => CapturedWork | null,
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
    const currentProjection = this.currentSql(journal, captured)
    if (currentProjection) {
      observed?.(currentProjection)
      return currentProjection
    }
    const contextId = captured.contextId
    const authority = copyJournalWorkAuthority(captured.authority)
    const signature = JSON.stringify(authority)
    const cursor = journal.cursor()
    const priorEntry = this.byJournal.get(journal)
    const prior = priorEntry?.kind === 'full' ? priorEntry.projection : undefined
    const sameContext =
      prior?.epoch === cursor.epoch && prior.contextId === contextId ? prior : undefined
    const input = {
      authority,
      start: sameContext?.submissionCount ?? 0,
      floor: sameContext ? 0 : undefined,
      firstInputSubmissionKey: sameContext?.firstInputSubmissionKey ?? null
    }
    const key = JSON.stringify({
      cursor,
      physicalCursor: journal.physicalCursor(),
      contextId,
      input
    })
    let pending = this.pending.get(journal)
    if (pending?.key !== key) {
      const next: PendingObservation = {
        key,
        result: journal.reads.observer(input).finally(() => {
          if (this.pending.get(journal) === next) {
            this.pending.delete(journal)
          }
        })
      }
      this.pending.set(journal, next)
      pending = next
    }
    const result = await pending.result
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
    const stop = authority.stop
    const savedStop = stop && { sequence: stop.sequence, event: stop.event }
    this.byJournal.set(journal, {
      kind: 'full',
      projection,
      physicalCursor: result.physicalCursor,
      savedStop
    })
    observed?.(projection)
    return projection
  }
}
