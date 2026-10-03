// Decides, from one process-table capture and the daemon's durable PTY ownership records, which
// processes are leftovers nobody owns any more. Pure: no clock, no signals, no disk — every input
// is passed in, so the classification can be tested without a single real process.
//
// Kill authority is identity, never location. A process is signalled only when its pid and start
// time exactly match one the daemon recorded while its root was alive to prove the parentage, or
// when it still descends from such a process. Process groups are reissued to strangers once their
// leader exits, and on macOS every launchd app is parented by pid 1, so neither "is in a group we
// once used" nor "looks orphaned" says anything about whose process it is.

import { hasUnambiguousStartTime } from '../pty-descendant-termination'
import {
  buildOrphanProcessTree,
  collectProtectedAncestry,
  descendantsOf,
  isProtected,
  protectLiveTree,
  type OrphanProcessTree
} from './daemon-orphan-process-tree'
import type { ProcessTableRow } from '../pty-process-table-parser'
import {
  MAX_OWNED_PROCESSES_PER_RECORD,
  ptyOwnershipRecordKey,
  recordKeyOf,
  type OwnedProcessIdentity,
  type PtyOwnershipRecord
} from './pty-ownership-record'

/** Why a record is being acted on. `stranded_root` means the PTY's own root is still running under
 *  the identity recorded for it; `orphaned_descendant` means only recorded descendants survive. */
export type OrphanReapReason = 'stranded_root' | 'orphaned_descendant'

/** Why a record was retired. Every one is a way for the obligation to die. */
export type OrphanRecordDropReason =
  /** No recorded identity is alive any more. */
  | 'settled'
  | 'expired'
  /** A recorded pid is alive but under an identity that cannot be proven ours, and a record that
   *  is not live can never gain proof later. */
  | 'unprovable'
  /** This daemon wrote the record and the session has since ended under it. Whatever the session
   *  left running outlived a teardown that did run; this reaper only answers for daemons that died
   *  before theirs could. */
  | 'session_ended'

/** Why a record was left alone this tick. Named rather than silent, because "nothing was there"
 *  and "we refused to act on what was there" are different facts when a leak is investigated. */
export type OrphanReapSkipReason =
  | 'live_session'
  | 'owning_daemon_alive'
  | 'within_spawn_grace'
  | 'protected_process'
  | 'awaiting_second_observation'

export type LiveSessionIdentity = {
  sessionId: string
  /** Absent on a session whose generation the host could not report. That ambiguity protects every
   *  record for the session id rather than none of them: "some generation of this is live" is a
   *  reason to leave all of them alone, never a reason to reap the ones that did not match. */
  incarnationId?: string
  /** The live root this daemon is still driving. Its whole tree is excluded from every candidate
   *  set, whether or not any record names it. */
  pid?: number | null
}

export type OrphanReapTarget = {
  key: string
  sessionId: string
  incarnationId: string
  reason: OrphanReapReason
  pgids: number[]
  members: ProcessTableRow[]
  /** Processes sitting in a recorded group that match no recorded identity. Reported so a leak
   *  that escaped identity capture is visible, never signalled. */
  unverifiedGroupMembers: number
}

export type OrphanReapPlan = {
  /** Records seen on two consecutive observations whose recorded identities are still alive. */
  reap: OrphanReapTarget[]
  /** Record keys that looked reapable for the first time. Carried to the next tick, nothing else. */
  confirmNext: string[]
  /** Live records whose identities were re-derived from this capture. */
  refreshed: PtyOwnershipRecord[]
  dropped: { key: string; sessionId: string; reason: OrphanRecordDropReason }[]
  skipped: { key: string; sessionId: string; reason: OrphanReapSkipReason }[]
}

export type OrphanReapPlanInput = {
  records: readonly PtyOwnershipRecord[]
  /** Sessions this daemon currently has a live root for, listed after the capture was taken. */
  liveSessions: readonly LiveSessionIdentity[]
  table: readonly ProcessTableRow[]
  /** When the capture began; a start time in that same second cannot be told apart from a reuse. */
  capturedAtMs: number
  /** This daemon's own pid: its ancestry is excluded from every candidate set. */
  selfPid: number
  /** This daemon's start time, so a record written by an earlier daemon that held the same pid is
   *  not mistaken for one of ours. Null when unknown. */
  selfStartedAtMs: number | null
  /** Record keys that already looked reapable on the previous tick. */
  pendingConfirmations: ReadonlySet<string>
  nowMs: number
  /** A record younger than this is never reaped, so a create still settling cannot be swept by a
   *  tick that lands between the spawn and the host's session map write. */
  spawnGraceMs: number
  /** A record older than this is abandoned, so nothing is held for pid reuse to catch up with. */
  maxRecordAgeMs: number
  /** Tolerance when matching a recorded daemon start time against a process table's second-
   *  resolution `lstart`. */
  daemonStartToleranceMs: number
}

function parseStartedAtMs(startedAt: string | null | undefined): number | null {
  if (!startedAt) {
    return null
  }
  const parsed = Date.parse(startedAt)
  return Number.isFinite(parsed) ? parsed : null
}

/** The live row for a recorded identity, only when its start time is exactly the recorded one. */
function matchIdentity(
  identity: { pid: number; startedAt: string | null },
  byPid: ReadonlyMap<number, ProcessTableRow>
): ProcessTableRow | undefined {
  const row = byPid.get(identity.pid)
  // No recorded start time is no identity at all: a pid alone is exactly what reuse recycles.
  return row && identity.startedAt !== null && row.startedAt === identity.startedAt
    ? row
    : undefined
}

/** True when this very daemon wrote the record: same pid, and no start time that says otherwise. */
function writtenBySelf(record: PtyOwnershipRecord, input: OrphanReapPlanInput): boolean {
  if (record.daemon.pid !== input.selfPid) {
    return false
  }
  // Unknown on either side reads as ours: that only ever retires a record, never signals one.
  return (
    record.daemon.startedAtMs === null ||
    input.selfStartedAtMs === null ||
    Math.abs(record.daemon.startedAtMs - input.selfStartedAtMs) <= input.daemonStartToleranceMs
  )
}

/** True when the daemon that wrote this record is still the process running under that pid. */
export function owningDaemonStillAlive(
  record: PtyOwnershipRecord,
  byPid: ReadonlyMap<number, ProcessTableRow>,
  selfPid: number,
  toleranceMs: number
): boolean {
  if (record.daemon.pid === selfPid) {
    return false
  }
  const row = byPid.get(record.daemon.pid)
  if (!row) {
    return false
  }
  // With no recorded start time the pid alone has to carry it. Fail closed: leaving another
  // daemon's live terminals alone costs one tick, killing them costs the user their work.
  if (record.daemon.startedAtMs === null) {
    return true
  }
  const startedAtMs = parseStartedAtMs(row.startedAt)
  return startedAtMs === null || Math.abs(startedAtMs - record.daemon.startedAtMs) <= toleranceMs
}

/**
 * Re-derive a live PTY's owned identities from the capture.
 *
 * The parent walk from a root the daemon is still driving is what proves ownership, so this is the
 * only moment an identity may be written down. The list is replaced rather than merged: it names
 * exactly the tree as it stands, so dead entries and deliberately detached processes both fall out.
 */
function refreshLiveRecord(
  record: PtyOwnershipRecord,
  rootRow: ProcessTableRow | undefined,
  tree: OrphanProcessTree,
  input: OrphanReapPlanInput
): PtyOwnershipRecord {
  if (!rootRow) {
    return { ...record, recordedAt: input.nowMs }
  }
  const processes: OwnedProcessIdentity[] = []
  const pgids = new Set<number>(rootRow.pgid > 1 ? [rootRow.pgid] : [])
  for (const row of descendantsOf(tree, rootRow.pid)) {
    // A start time in the capture's own second could belong to a same-second reuse; leave it for
    // the next tick rather than pin a stranger's identity.
    if (!hasUnambiguousStartTime(row.startedAt, input.capturedAtMs)) {
      continue
    }
    if (processes.length < MAX_OWNED_PROCESSES_PER_RECORD) {
      processes.push({ pid: row.pid, startedAt: row.startedAt })
    }
    if (row.pgid > 1) {
      pgids.add(row.pgid)
    }
  }
  return {
    ...record,
    root: { pid: rootRow.pid, startedAt: rootRow.startedAt },
    processes,
    pgids: [...pgids],
    recordedAt: input.nowMs
  }
}

/** The recorded identities still alive, and everything still descended from them. */
function collectOwnedMembers(
  record: PtyOwnershipRecord,
  tree: OrphanProcessTree
): { rootRow: ProcessTableRow | undefined; members: ProcessTableRow[] } {
  const byPid = tree.byPid
  const rootRow = matchIdentity(record.root, byPid)
  const seeds = [
    ...(rootRow ? [rootRow] : []),
    ...record.processes.flatMap((identity) => matchIdentity(identity, byPid) ?? [])
  ]
  const members = new Map<number, ProcessTableRow>()
  for (const seed of seeds) {
    members.set(seed.pid, seed)
    for (const row of descendantsOf(tree, seed.pid)) {
      members.set(row.pid, row)
    }
  }
  return { rootRow, members: [...members.values()] }
}

/**
 * Classify every durable record against one process-table capture.
 *
 * Nothing here is derived from a root this daemon is currently driving, so nothing here is
 * signalled on first sight: a record only reaches `reap` when the previous tick already reached
 * the same verdict about it. The second observation re-derives everything from scratch — the
 * first carries no member list forward, only the fact that the suspicion is not new.
 */
export function planOrphanReap(input: OrphanReapPlanInput): OrphanReapPlan {
  const plan: OrphanReapPlan = {
    reap: [],
    confirmNext: [],
    refreshed: [],
    dropped: [],
    skipped: []
  }
  // One index per tick: every walk below shares it rather than rescanning the table per seed.
  const tree = buildOrphanProcessTree(input.table)
  const byPid = tree.byPid
  const protectedProcesses = collectProtectedAncestry(tree, input.selfPid)
  const liveKeys = new Set<string>()
  const liveRootPidByKey = new Map<string, number>()
  const liveSessionIdsOfUnknownGeneration = new Set<string>()
  for (const session of input.liveSessions) {
    const livePid = typeof session.pid === 'number' && session.pid > 0 ? session.pid : null
    if (livePid !== null) {
      protectLiveTree(protectedProcesses, tree, livePid)
    }
    if (session.incarnationId === undefined) {
      liveSessionIdsOfUnknownGeneration.add(session.sessionId)
      continue
    }
    const key = ptyOwnershipRecordKey(session.sessionId, session.incarnationId)
    liveKeys.add(key)
    if (livePid !== null) {
      liveRootPidByKey.set(key, livePid)
    }
  }

  for (const record of input.records) {
    const key = recordKeyOf(record)
    const skip = (reason: OrphanReapSkipReason): void => {
      plan.skipped.push({ key, sessionId: record.sessionId, reason })
    }
    const drop = (reason: OrphanRecordDropReason): void => {
      plan.dropped.push({ key, sessionId: record.sessionId, reason })
    }

    if (liveKeys.has(key) || liveSessionIdsOfUnknownGeneration.has(record.sessionId)) {
      // The host naming this exact generation's pid, after the capture, is what proves the row is
      // ours even when the spawn-time probe never landed a start time.
      const rootRow =
        matchIdentity(record.root, byPid) ??
        (liveRootPidByKey.get(key) === record.root.pid ? byPid.get(record.root.pid) : undefined)
      plan.refreshed.push(refreshLiveRecord(record, rootRow, tree, input))
      skip('live_session')
      continue
    }
    if (writtenBySelf(record, input)) {
      drop('session_ended')
      continue
    }
    if (input.nowMs - record.recordedAt > input.maxRecordAgeMs) {
      drop('expired')
      continue
    }
    if (owningDaemonStillAlive(record, byPid, input.selfPid, input.daemonStartToleranceMs)) {
      skip('owning_daemon_alive')
      continue
    }

    const owned = collectOwnedMembers(record, tree)
    const members = owned.members.filter((row) => !isProtected(row, protectedProcesses))
    if (members.length === 0) {
      if (owned.members.length > 0) {
        // Our identity is alive but now inside a live session's tree or the daemon's own ancestry.
        // That cannot be a leftover; leave it and let the record expire if it never resolves.
        skip('protected_process')
        continue
      }
      const recordedPidStillInUse =
        byPid.has(record.root.pid) || record.processes.some((entry) => byPid.has(entry.pid))
      // Nothing recorded is alive under its recorded identity. A pid still in use belongs to
      // somebody else — or to a root whose start time was never captured, which can never be
      // proven now that no live session backs it. Either way nothing may be signalled.
      drop(recordedPidStillInUse ? 'unprovable' : 'settled')
      continue
    }
    if (input.nowMs - record.recordedAt < input.spawnGraceMs) {
      skip('within_spawn_grace')
      continue
    }
    if (!input.pendingConfirmations.has(key)) {
      plan.confirmNext.push(key)
      skip('awaiting_second_observation')
      continue
    }
    const memberPids = new Set(members.map((row) => row.pid))
    const recordedGroups = new Set(record.pgids)
    plan.reap.push({
      key,
      sessionId: record.sessionId,
      incarnationId: record.incarnationId,
      reason: owned.rootRow ? 'stranded_root' : 'orphaned_descendant',
      pgids: [...new Set(members.map((row) => row.pgid))],
      members,
      unverifiedGroupMembers: input.table.filter(
        (row) =>
          recordedGroups.has(row.pgid) &&
          !memberPids.has(row.pid) &&
          !isProtected(row, protectedProcesses)
      ).length
    })
    // A reaped record keeps its confirmation, so a kill that does not take effect is retried on
    // the next tick instead of restarting its two-observation clock.
    plan.confirmNext.push(key)
  }

  return plan
}
