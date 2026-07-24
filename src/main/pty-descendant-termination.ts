import { execFile } from 'node:child_process'

export const DESCENDANT_KILL_GRACE_MS = 2_000
export const DESCENDANT_SNAPSHOT_TIMEOUT_MS = 1_000
// Why: a full process table on a busy host can exceed execFile's 1MB default;
// truncation would silently drop descendants from the snapshot.
const PS_MAX_BUFFER_BYTES = 32 * 1024 * 1024

export type ProcessTableRow = {
  pid: number
  ppid: number
  pgid: number
  /** ps lstart text, kept verbatim. Delayed SIGKILL additionally requires an
   * unambiguous capture-second boundary and matching pgid. */
  startedAt: string
}

export type DescendantSnapshot = {
  rootPgid: number | null
  descendants: ProcessTableRow[]
  /** Wall-clock boundary for deciding whether ps's second-resolution lstart
   *  can safely distinguish this process from a later PID reuse. */
  capturedAtMs: number
}

export type ProcessTableCapture = {
  rows: ProcessTableRow[]
  /** Start boundary of the scan that produced rows, never a later consumer's time. */
  capturedAtMs: number
}

export type ProcessTableReader = (timeoutMs?: number) => Promise<ProcessTableCapture>
export type SignalSender = (pid: number, signal: NodeJS.Signals) => void

export function parseProcessTable(psOutput: string): ProcessTableRow[] {
  const rows: ProcessTableRow[] = []
  for (const line of psOutput.split('\n')) {
    // lstart itself contains spaces ("Mon Jul 13 12:54:47 2026"), so only the
    // three leading numeric columns are positional.
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/)
    if (!match) {
      continue
    }
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      startedAt: match[4]
    })
  }
  return rows
}

function readFreshProcessTable(
  timeoutMs = DESCENDANT_SNAPSHOT_TIMEOUT_MS
): Promise<ProcessTableCapture> {
  // Why: identity safety must use the boundary before ps starts. Stamping the
  // result later could make a capture-second PID look safe after a rollover.
  const capturedAtMs = Date.now()
  return new Promise((resolve, reject) => {
    execFile(
      'ps',
      ['-axo', 'pid=,ppid=,pgid=,lstart='],
      {
        maxBuffer: PS_MAX_BUFFER_BYTES,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        // Why: ps localizes lstart, but delayed identity checks must parse it
        // identically for every user locale.
        env: { ...process.env, LANG: 'C', LC_ALL: 'C' }
      },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        resolve({ rows: parseProcessTable(stdout), capturedAtMs })
      }
    )
  })
}

/** Coalesces same-turn teardown bursts but never serves a completed or already
 * started scan to a later request, because stale PIDs are unsafe to signal. */
export function createProcessTableSnapshotReader(
  readFresh: ProcessTableReader
): ProcessTableReader {
  let queued: { promise: Promise<ProcessTableCapture>; started: boolean } | null = null

  return (timeoutMs) => {
    if (queued && !queued.started) {
      return queued.promise
    }

    const entry: { promise: Promise<ProcessTableCapture>; started: boolean } = {
      promise: Promise.resolve(undefined as never),
      started: false
    }
    entry.promise = Promise.resolve().then(() => {
      // Why: a later caller's deadline starts when it requests a fresh table.
      // Waiting behind an older scan can consume that entire budget, then run
      // this subprocess after nobody can use its result.
      entry.started = true
      return readFresh(timeoutMs)
    })
    queued = entry
    const clearQueued = (): void => {
      if (queued === entry) {
        queued = null
      }
    }
    void entry.promise.then(clearQueued, clearQueued)
    return entry.promise
  }
}

const readProcessTable = createProcessTableSnapshotReader(readFreshProcessTable)

function readProcessTableBeforeDeadline(
  readTable: ProcessTableReader,
  timeoutMs: number
): Promise<ProcessTableCapture | null> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (capture: ProcessTableCapture | null): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      resolve(capture)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    timer.unref?.()
    try {
      void readTable(timeoutMs).then(
        (rows) => finish(rows),
        () => finish(null)
      )
    } catch {
      finish(null)
    }
  })
}

export function collectDescendantRows(
  rootPid: number,
  table: ProcessTableRow[],
  capturedAtMs = Date.now()
): DescendantSnapshot {
  const childrenByPpid = new Map<number, ProcessTableRow[]>()
  let rootRow: ProcessTableRow | null = null
  for (const row of table) {
    if (row.pid === rootPid) {
      rootRow = row
      continue
    }
    const siblings = childrenByPpid.get(row.ppid)
    if (siblings) {
      siblings.push(row)
    } else {
      childrenByPpid.set(row.ppid, [row])
    }
  }
  // Why: a ppid walk is only meaningful while the root is alive in this snapshot.
  // An absent root has already exited — its real descendants reparent to pid 1 and
  // become unreachable by ppid, so any rows still pointing at the vacated PID are a
  // PID-reuse coincidence. Sweeping them could signal an unrelated process, so bail.
  if (!rootRow) {
    return { rootPgid: null, descendants: [], capturedAtMs }
  }
  const descendants: ProcessTableRow[] = []
  const queue = [rootPid]
  const visited = new Set(queue)
  for (let nextIndex = 0; nextIndex < queue.length; nextIndex += 1) {
    const pid = queue[nextIndex]
    for (const child of childrenByPpid.get(pid) ?? []) {
      // Why: ps is not an atomic snapshot. PID reuse can produce duplicate or
      // cyclic-looking rows, which must not hang the Electron main thread.
      if (visited.has(child.pid)) {
        continue
      }
      visited.add(child.pid)
      descendants.push(child)
      queue.push(child.pid)
    }
  }
  return { rootPgid: rootRow.pgid, descendants, capturedAtMs }
}

type SnapshotDeps = {
  readTable?: ProcessTableReader
  platform?: NodeJS.Platform
  timeoutMs?: number
}

/**
 * Snapshots a PTY root's live descendant tree. Must run BEFORE the root is
 * signalled: once the root dies, surviving descendants reparent to pid 1 and
 * can no longer be found by a ppid walk. Resolves null (never rejects) on
 * Windows, ps failure, or timeout — callers then degrade to today's
 * shell-only kill.
 */
export async function captureDescendantSnapshot(
  rootPid: number,
  deps: SnapshotDeps = {}
): Promise<DescendantSnapshot | null> {
  const platform = deps.platform ?? process.platform
  if (platform === 'win32' || !Number.isInteger(rootPid) || rootPid <= 0) {
    return null
  }
  const readTable = deps.readTable ?? readProcessTable
  const timeoutMs = deps.timeoutMs ?? DESCENDANT_SNAPSHOT_TIMEOUT_MS
  // Why both layers: the deadline keeps injected/custom readers bounded while
  // the production execFile timeout actually kills a wedged ps subprocess.
  const capture = await readProcessTableBeforeDeadline(readTable, timeoutMs)
  if (!capture) {
    return null
  }
  return collectDescendantRows(rootPid, capture.rows, capture.capturedAtMs)
}

/**
 * Standard agent-session kill sequencing: snapshot the descendant tree,
 * signal its members, then run the caller's root kill. Callers must not signal
 * the root before this runs — a dead root's descendants reparent to pid 1 and
 * become unfindable. Snapshot failure degrades to killRoot alone.
 */
export async function killWithDescendantSweep(
  rootPid: number,
  killRoot: () => void,
  deps: SnapshotDeps & TerminateDeps & { ownsRoot?: () => boolean } = {}
): Promise<void> {
  const snapshot = await captureDescendantSnapshot(rootPid, deps)
  try {
    // Signal the captured descendants while their parent links still exist;
    // killing the root first creates a reparent/PID-reuse window.
    if (snapshot && (deps.ownsRoot?.() ?? true)) {
      terminateDescendantSnapshot(snapshot, deps)
    }
  } finally {
    killRoot()
  }
}

function defaultSendSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch {
    /* already gone */
  }
}

type TerminateDeps = {
  readTable?: ProcessTableReader
  sendSignal?: SignalSender
  graceMs?: number
  timeoutMs?: number
}

function hasUnambiguousStartIdentity(row: ProcessTableRow, capturedAtMs: number): boolean {
  const startedAtMs = Date.parse(row.startedAt)
  if (!Number.isFinite(startedAtMs)) {
    return false
  }
  // ps lstart is second-resolution. A process born in the capture second can
  // be replaced by a different process with the same displayed timestamp.
  return startedAtMs < Math.floor(capturedAtMs / 1_000) * 1_000
}

/**
 * Terminates a snapshotted descendant tree: SIGTERM every descendant now,
 * reaching detached-pgid children the PTY's SIGHUP cannot, then after a grace
 * window SIGKILL identity-safe survivors. Processes born in the capture second
 * are not escalated because ps cannot distinguish same-second PID reuse.
 */
export function terminateDescendantSnapshot(
  snapshot: DescendantSnapshot,
  deps: TerminateDeps = {}
): void {
  const sendSignal = deps.sendSignal ?? defaultSendSignal
  const readTable = deps.readTable ?? readProcessTable
  for (const row of snapshot.descendants) {
    sendSignal(row.pid, 'SIGTERM')
  }
  if (snapshot.descendants.length === 0) {
    return
  }
  const timer = setTimeout(() => {
    void readProcessTableBeforeDeadline(
      readTable,
      deps.timeoutMs ?? DESCENDANT_SNAPSHOT_TIMEOUT_MS
    ).then((capture) => {
      if (!capture) {
        return
      }
      const expectedPids = new Set(snapshot.descendants.map((row) => row.pid))
      const liveTargets = new Map<number, ProcessTableRow | null>()
      // Why: a process table may be large, while one agent's descendants are
      // normally few. Index only signal targets instead of duplicating every row.
      for (const live of capture.rows) {
        if (expectedPids.has(live.pid)) {
          // Duplicate PID rows make identity ambiguous, so never escalate them.
          liveTargets.set(live.pid, liveTargets.has(live.pid) ? null : live)
        }
      }
      for (const row of snapshot.descendants) {
        const live = liveTargets.get(row.pid)
        if (
          hasUnambiguousStartIdentity(row, snapshot.capturedAtMs) &&
          live?.startedAt === row.startedAt &&
          live.pgid === row.pgid
        ) {
          sendSignal(row.pid, 'SIGKILL')
        }
      }
    })
  }, deps.graceMs ?? DESCENDANT_KILL_GRACE_MS)
  timer.unref?.()
}
