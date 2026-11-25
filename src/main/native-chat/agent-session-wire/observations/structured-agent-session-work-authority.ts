import type { SqlAgentSessionJournal } from '../../agent-session-journal/journal-sql-store'
import {
  copyJournalCurrentWorkAuthority,
  type JournalObserverResult,
  type JournalCurrentWorkAuthority,
  type JournalWorkAuthority
} from '../../agent-session-journal/journal-observer-read'
import type { JournalSqlWorkResult } from '../../agent-session-journal/journal-work-read'
import type { JournalDomainHistoryWork } from '../../agent-session-journal/journal-domain-history-page'
import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalLatestStop } from '../../agent-session-journal/context-epochs/journal-stop-turn-end'
import { sameJournalCursor } from '../../agent-session-journal/replay/journal-cursor'
import { structuredAgentSessionHandoverAuthority } from '../delivery/structured-agent-session-handing-over'
import type { StructuredAgentSessionStatusFeedDeps } from './structured-agent-session-status-feed-deps'

/** Capture live owners synchronously; the asynchronous Stop answer is pinned to its read identity. */
export function captureStructuredAgentSessionWorkAuthority(
  journal: SqlAgentSessionJournal,
  sessionId: string,
  deps: Pick<
    StructuredAgentSessionStatusFeedDeps,
    'sessions' | 'getConversation' | 'replacedRuntime'
  >,
  stop: { cursor: AgentJournalCursor; revision: number; latest: JournalLatestStop | null }
): { authority: JournalWorkAuthority; contextId: string | null } | null {
  const session = deps.sessions.get(sessionId)
  if (
    session?.journal !== journal ||
    journal.isClosed ||
    stop.revision !== journal.stopMarks.revision() ||
    !sameJournalCursor(stop.cursor, journal.cursor())
  ) {
    return null
  }
  const record = deps.getConversation(sessionId)
  const child = session.child
  const heldSends = heldSendIds(child?.heldSends?.())
  return {
    contextId: record?.providerContextBoundary?.operationId ?? null,
    authority: {
      handle: journal.observationHandle(),
      record,
      ended: session.lastEndedChild,
      replaced: deps.replacedRuntime?.(sessionId),
      child: child === undefined || child === null ? child : { fence: child.fence, heldSends },
      ...structuredAgentSessionHandoverAuthority(journal),
      openedThrough: journal.openingCursor(),
      reopenFloor: journal.reopenFloor(),
      operationalRevision: session.operationalRevision ?? 0,
      stopRevision: stop.revision,
      stop: stop.latest
    }
  }
}

const heldSnapshots = new WeakMap<ReadonlySet<string>, string[]>()

function heldSendIds(held: ReadonlySet<string> | undefined): string[] | undefined {
  if (!held) {
    return undefined
  }
  let ids = heldSnapshots.get(held)
  if (!ids) {
    ids = [...held].sort()
    heldSnapshots.set(held, ids)
  }
  return ids
}

/** Host-side validation at a warm frame. Set membership is captured at its mutation edges. */
function liveWorkAuthorityKey(authority: JournalCurrentWorkAuthority) {
  const { record, ended, replaced, child } = authority
  return {
    held: child?.heldSends,
    handingOver: authority.handingOver,
    continuingUnadmitted: authority.continuingUnadmitted,
    finalizing: authority.finalizing,
    owners: JSON.stringify([
      authority.handle,
      record?.currentFence,
      record?.ownerObservation.claimStatus,
      record?.ownerObservation.unreconciled,
      record?.ownerObservation.handoffStage,
      ended && [ended.fence, ended.rootGone, ended.cause],
      replaced?.fence,
      child === null ? null : (child?.fence ?? false),
      authority.openedThrough,
      authority.operationalRevision
    ])
  }
}

function sameLiveWorkAuthority(
  left: ReturnType<typeof liveWorkAuthorityKey>,
  right: ReturnType<typeof liveWorkAuthorityKey>
): boolean {
  const sameIds = (a: string[] | undefined, b: string[] | undefined) =>
    a === b ||
    (a !== undefined &&
      b !== undefined &&
      a.length === b.length &&
      a.every((id, index) => id === b[index]))
  return (
    left.owners === right.owners &&
    sameIds(left.held, right.held) &&
    sameIds(left.handingOver, right.handingOver) &&
    sameIds(left.continuingUnadmitted, right.continuingUnadmitted) &&
    sameIds(left.finalizing, right.finalizing)
  )
}

type WorkState = JournalObserverResult['work']
const baselines = new WeakMap<
  WorkState,
  {
    key: ReturnType<typeof liveWorkAuthorityKey>
    authority: JournalCurrentWorkAuthority
  }
>()

export function rememberWorkAuthority(
  state: WorkState,
  live: JournalCurrentWorkAuthority,
  authority = copyJournalCurrentWorkAuthority(live)
): void {
  baselines.set(state, { key: liveWorkAuthorityKey(live), authority })
}

export function cachedWorkAuthority(state: WorkState, live: JournalCurrentWorkAuthority) {
  const prior = baselines.get(state)
  return prior && sameLiveWorkAuthority(prior.key, liveWorkAuthorityKey(live))
    ? prior.authority
    : undefined
}

/** A warm frame's rows must still share the cached work's snapshot and live owners. */
export async function readCachedWorkFrame<T>(
  journal: SqlAgentSessionJournal,
  captured: { contextId: string | null; authority: JournalWorkAuthority },
  capture: () => typeof captured | null,
  read: (work: JournalDomainHistoryWork) => Promise<{ value: T; work?: JournalSqlWorkResult }>,
  cached: JournalSqlWorkResult
) {
  const key = liveWorkAuthorityKey(captured.authority)
  const current = () => {
    const live = capture()
    return (
      live !== null &&
      live.contextId === captured.contextId &&
      sameJournalCursor(cached.cursor, journal.cursor()) &&
      sameJournalCursor(cached.physicalCursor, journal.physicalCursor()) &&
      sameLiveWorkAuthority(key, liveWorkAuthorityKey(live.authority))
    )
  }
  const rows = await read({
    read: { authority: cached.authority, operation: { kind: 'state' } },
    unlessAt: { cursor: cached.cursor, physicalCursor: cached.physicalCursor }
  })
  return !rows.work && current() ? { answer: cached, value: rows.value, current } : null
}
