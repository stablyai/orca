// The OS identity of one PTY incarnation the daemon owns, as a durable fact.
//
// This is the whole obligation, not the minimum field that answers one question: a reaper that
// only knows a root pid cannot find anything once that root exits, because surviving children
// reparent to pid 1 and leave no parent link back. So the owner writes down, while the root is
// alive to prove it, the exact identity (pid plus start time) of every process in the tree. Only
// those identities, and processes still descended from them, ever authorize a signal. Process
// groups and the terminal are kept as discovery hints: both are reissued to strangers.

/** One process, pinned by the pair that survives pid reuse. `startedAt` is `ps` lstart text. */
export type OwnedProcessIdentity = { pid: number; startedAt: string }

/** Bound on identities kept per record, so one fork-heavy tree cannot grow the store without
 *  limit. Refresh replaces the list with the live tree, so this only clips pathological trees. */
export const MAX_OWNED_PROCESSES_PER_RECORD = 256

/** Where a record came from, and which questions it can still answer. */
export type PtyOwnershipRecord = {
  /** Public terminal session id this PTY was spawned for. */
  sessionId: string
  /** `Session.incarnationId` — one PTY generation. Records are keyed by it as well as by the
   *  session id, so a respawn onto the same id never overwrites the previous generation's
   *  still-owed cleanup. */
  incarnationId: string
  /** The PTY's root process. `startedAt` is `ps` lstart text, verbatim, so it compares against a
   *  process-table capture without a second conversion; null when the spawn-time probe failed and
   *  no later capture has backfilled it. A record with no root start time can never authorize a
   *  signal, only expire. */
  root: { pid: number; startedAt: string | null }
  /** The root's descendants as of the last observation that proved them ours — a parent walk from
   *  a root the daemon was still driving. Replaced wholesale each time, so a process that left the
   *  tree while the session was live (deliberately detached) stops being claimed. */
  processes: OwnedProcessIdentity[]
  /** Groups the root and `processes` occupied at that observation, pruned to groups that still had
   *  a member. A hint for finding candidates and for reporting what was left alone; a group id is
   *  reissued once its leader exits, so it never authorizes a signal on its own. */
  pgids: number[]
  /** Controlling terminal as `ps -o tty=` prints it (no `/dev/` prefix), taken from node-pty's
   *  slave device path so it costs nothing to record. The periodic reconciler deliberately does
   *  not correlate on it: asking `ps` for the `tty` column across a whole host measures 19-28s on
   *  a 1,900-process Mac against 0.12s without it. A per-session sweep can still use it, because
   *  `ps -t <name>` selects rather than resolving every row. */
  tty: string | null
  /** The daemon incarnation that owns this record. A later daemon sharing the runtime directory
   *  must be able to tell "the owner died and left this" from "the owner is still running it". */
  daemon: { pid: number; startedAtMs: number | null }
  /** Refreshed on every tick a live session still backs this record, so expiry ages out abandoned
   *  obligations without ever aging out a week-old terminal. */
  recordedAt: number
}

/** Store key. The pair is the identity: the session id alone would let generation N+1 silently
 *  assume generation N's debt, which is how a leaked group stops being anybody's. */
export function ptyOwnershipRecordKey(sessionId: string, incarnationId: string): string {
  return `${sessionId}\u0000${incarnationId}`
}

export function recordKeyOf(record: PtyOwnershipRecord): string {
  return ptyOwnershipRecordKey(record.sessionId, record.incarnationId)
}

/** `ps -o tty=` prints `ttys004` / `pts/3`, never the device path node-pty hands back. */
export function ttyNameFromSlavePath(slavePath: string | undefined): string | null {
  if (!slavePath) {
    return null
  }
  const name = slavePath.startsWith('/dev/') ? slavePath.slice('/dev/'.length) : slavePath
  return name.length > 0 ? name : null
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function parseOwnedProcess(value: unknown): OwnedProcessIdentity | null {
  const row = asRecordObject(value)
  return row &&
    isPositiveInteger(row.pid) &&
    typeof row.startedAt === 'string' &&
    row.startedAt.length > 0
    ? { pid: row.pid, startedAt: row.startedAt }
    : null
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** A plain object view of an unknown value, or null. Spread rather than asserted so a row this
 *  daemon did not write cannot smuggle a shape past the reader. */
export function asRecordObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? { ...value } : null
}

/**
 * Read one persisted row, or reject it.
 *
 * Deliberately demands only what identity and routing need — session id, incarnation id, a usable
 * root pid, an owning daemon pid, a recording time — and coerces everything else rather than
 * refusing the row over it. A stricter read would reject rows an older build of this same daemon
 * wrote, and a reader that rejects its own predecessor's rows forgets exactly the processes it
 * exists to find.
 */
export function parsePtyOwnershipRecord(value: unknown): PtyOwnershipRecord | null {
  const row = asRecordObject(value)
  const root = asRecordObject(row?.root)
  const daemon = asRecordObject(row?.daemon)
  if (!row || !root || !daemon) {
    return null
  }
  const { sessionId, incarnationId, recordedAt } = row
  if (
    typeof sessionId !== 'string' ||
    sessionId.length === 0 ||
    typeof incarnationId !== 'string' ||
    incarnationId.length === 0 ||
    !isPositiveInteger(root.pid) ||
    !isPositiveInteger(daemon.pid) ||
    typeof recordedAt !== 'number' ||
    !Number.isFinite(recordedAt)
  ) {
    return null
  }
  return {
    sessionId,
    incarnationId,
    root: {
      pid: root.pid,
      startedAt: typeof root.startedAt === 'string' ? root.startedAt : null
    },
    processes: Array.isArray(row.processes)
      ? row.processes
          .map(parseOwnedProcess)
          .filter((entry): entry is OwnedProcessIdentity => entry !== null)
          .slice(0, MAX_OWNED_PROCESSES_PER_RECORD)
      : [],
    pgids: Array.isArray(row.pgids) ? row.pgids.filter(isPositiveInteger) : [],
    tty: typeof row.tty === 'string' && row.tty.length > 0 ? row.tty : null,
    daemon: { pid: daemon.pid, startedAtMs: finiteNumberOrNull(daemon.startedAtMs) },
    recordedAt
  }
}
