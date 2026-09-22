import { hasUnambiguousStartTime } from './pty-descendant-termination'
import type { PtySessionProcessIdentity } from './pty-session-identity'
import type { ProcessTableRow } from './pty-process-table-parser'

export type SessionSweepTargets = {
  /** Live rows this session owns. Never contains the root itself. */
  rows: ProcessTableRow[]
  /** Groups this capture proved the session owns, for the identity to carry forward. */
  ownedPgids: number[]
  /** Whether the root was still present in the capture these targets came from. */
  rootAlive: boolean
}

export type SessionSweepTargetInput = {
  identity: PtySessionProcessIdentity
  /** Whole-host capture: the ppid walk, known-group matches and ancestor protection all read it. */
  rows: readonly ProcessTableRow[]
  /** What `ps -t <ttyName>` returned, i.e. everything still on the session's terminal. */
  ttyRows?: readonly ProcessTableRow[] | undefined
  selfPid?: number
}

type ProtectedIdentities = { pids: Set<number>; pgids: Set<number> }

/**
 * Orca's own pid, every ancestor, and their process groups. A session's work
 * never legitimately includes the daemon, the app, or the shell that launched
 * them — but a tree member that never called setpgid can share a group with
 * one of them, and a single group signal would then take out the developer's
 * own terminal.
 */
function collectProtectedIdentities(
  rowsByPid: ReadonlyMap<number, ProcessTableRow>,
  selfPid: number
): ProtectedIdentities {
  const pids = new Set<number>()
  const pgids = new Set<number>()
  for (let cursor: number | undefined = selfPid; cursor !== undefined && cursor > 1;) {
    if (pids.has(cursor)) {
      break
    }
    pids.add(cursor)
    const row = rowsByPid.get(cursor)
    if (!row) {
      break
    }
    if (row.pgid > 1) {
      pgids.add(row.pgid)
    }
    cursor = row.ppid
  }
  return { pids, pgids }
}

function indexRows(rows: readonly ProcessTableRow[]): {
  byPid: Map<number, ProcessTableRow>
  ambiguous: Set<number>
} {
  const byPid = new Map<number, ProcessTableRow>()
  const ambiguous = new Set<number>()
  for (const row of rows) {
    if (byPid.has(row.pid)) {
      // A non-atomic read holding two rows for one pid cannot identify either.
      ambiguous.add(row.pid)
      continue
    }
    byPid.set(row.pid, row)
  }
  return { byPid, ambiguous }
}

/**
 * The latest moment a recorded group is known to have been this session's.
 *
 * For the root's own group that is at least the root's exit: the root held the
 * group's id as its pid until then, so no other group could have taken it.
 */
function ownedUntilMs(identity: PtySessionProcessIdentity, pgid: number): number | null {
  const group = identity.ownedGroups.get(pgid)
  if (!group) {
    return null
  }
  return pgid === identity.rootPid && identity.rootExitedAtMs !== null
    ? Math.max(group.lastOwnedAtMs, identity.rootExitedAtMs)
    : group.lastOwnedAtMs
}

type RecordedGroupVerdict = 'leader-verified' | 'leaderless' | 'reused'

/**
 * Whether a recorded group id still names this session's group in this capture.
 *
 * A group lives while any member does, and its id cannot be reissued while it
 * lives. So a leader born before the group was last owned proves continuity
 * for every member; a leader born after it means the id was freed and taken by
 * someone else. Without a leader the capture cannot say, and each member has
 * to prove it predates that moment itself.
 */
function verifyRecordedGroup(
  identity: PtySessionProcessIdentity,
  pgid: number,
  byPid: ReadonlyMap<number, ProcessTableRow>,
  rootAlive: boolean
): RecordedGroupVerdict {
  const leader = byPid.get(pgid)
  if (!leader || leader.pgid !== pgid) {
    return 'leaderless'
  }
  if (pgid === identity.rootPid) {
    return rootAlive ? 'leader-verified' : 'reused'
  }
  const ownedAtMs = ownedUntilMs(identity, pgid)
  return ownedAtMs !== null && hasUnambiguousStartTime(leader.startedAt, ownedAtMs)
    ? 'leader-verified'
    : 'reused'
}

/**
 * Resolves which live processes still belong to a PTY session, from the
 * identity captured while it was alive rather than from a live root.
 *
 * Three independent claims, unioned to a fixpoint so a process forked after the
 * root died is still reached through whichever of them names its parent:
 * - the ppid tree, while the root is present in this capture;
 * - membership of a process group this session owned, once that group proves
 *   it was never reissued (see verifyRecordedGroup);
 * - presence on the session's controlling terminal.
 *
 * The tty claim needs a boundary too. Once the root exits the kernel can hand
 * that terminal to a brand-new session, so afterwards a tty row counts only if
 * it was born before the second the root died — and not at all when the root is
 * gone with no recorded exit time.
 *
 * Group membership alone never teaches the sweep another group: only a row
 * reached by descent or by the terminal extends what the session is known to own.
 */
export function collectSessionSweepTargets(input: SessionSweepTargetInput): SessionSweepTargets {
  const { identity } = input
  const selfPid = input.selfPid ?? process.pid
  const { byPid, ambiguous } = indexRows(input.rows)
  const guarded = collectProtectedIdentities(byPid, selfPid)
  const rootRow = ambiguous.has(identity.rootPid) ? undefined : byPid.get(identity.rootPid)
  // Why the exit boundary outranks the table: once the root has been reaped, a row
  // wearing its pid is a stranger that inherited the number, so the ppid walk that
  // would descend from it — and the tree it claims — belong to somebody else.
  const rootAlive =
    identity.rootExitedAtMs === null &&
    rootRow !== undefined &&
    (identity.rootStartedAt === null || identity.rootStartedAt === rootRow.startedAt)

  const ttyPids = new Set<number>()
  // A daemon that shares the session's terminal makes the tty claim point at the
  // user's own shell, so the whole claim is dropped.
  const ttyRows = (input.ttyRows ?? []).some((row) => guarded.pids.has(row.pid))
    ? []
    : (input.ttyRows ?? [])
  for (const row of ttyRows) {
    ttyPids.add(row.pid)
    if (!byPid.has(row.pid) && !ambiguous.has(row.pid)) {
      byPid.set(row.pid, row)
    }
  }

  const recordedGroups = new Map<number, RecordedGroupVerdict>()
  for (const pgid of identity.ownedGroups.keys()) {
    recordedGroups.set(pgid, verifyRecordedGroup(identity, pgid, byPid, rootAlive))
  }
  // Groups a descendant or terminal row sits in right now: owned as of this capture.
  const learnedGroups = new Set<number>()
  const claimsGroup = (row: ProcessTableRow): boolean => {
    if (learnedGroups.has(row.pgid)) {
      return true
    }
    const verdict = recordedGroups.get(row.pgid)
    if (verdict === 'leader-verified') {
      return true
    }
    const ownedAtMs = ownedUntilMs(identity, row.pgid)
    return (
      verdict === 'leaderless' &&
      ownedAtMs !== null &&
      hasUnambiguousStartTime(row.startedAt, ownedAtMs)
    )
  }
  const claimsTty = (row: ProcessTableRow): boolean =>
    ttyPids.has(row.pid) &&
    // While the root holds the terminal open, nobody else can have acquired it. A
    // kill never records an exit time, so a root merely absent proves no boundary.
    (rootAlive ||
      (identity.rootExitedAtMs !== null &&
        hasUnambiguousStartTime(row.startedAt, identity.rootExitedAtMs)))

  const accepted = new Map<number, ProcessTableRow>()
  const ownedPgids = new Set<number>()
  for (let changed = true; changed;) {
    changed = false
    for (const row of byPid.values()) {
      if (
        accepted.has(row.pid) ||
        row.pid <= 1 ||
        row.pid === identity.rootPid ||
        row.pid === selfPid ||
        ambiguous.has(row.pid) ||
        guarded.pids.has(row.pid) ||
        guarded.pgids.has(row.pgid)
      ) {
        continue
      }
      // A ppid link to a vacated root pid is PID-reuse coincidence, not descent.
      const descends = (rootAlive && row.ppid === identity.rootPid) || accepted.has(row.ppid)
      const byTerminal = claimsTty(row)
      if (!descends && !byTerminal && !claimsGroup(row)) {
        continue
      }
      accepted.set(row.pid, row)
      if (row.pgid > 1) {
        ownedPgids.add(row.pgid)
        if (descends || byTerminal) {
          learnedGroups.add(row.pgid)
        }
      }
      changed = true
    }
  }
  if (rootAlive && rootRow && rootRow.pgid > 1) {
    ownedPgids.add(rootRow.pgid)
  }
  return { rows: [...accepted.values()], ownedPgids: [...ownedPgids], rootAlive }
}
