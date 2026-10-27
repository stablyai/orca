import { execFile } from 'node:child_process'
import { matchingSignalTargets } from './pty-descendant-signal-targets'
import {
  readProcessTableBeforeDeadline,
  readProcessTableWithRetries
} from './pty-process-table-deadline'
export { readProcessTableBeforeDeadline } from './pty-process-table-deadline'
import { parseProcessTable, type ProcessTableRow } from './pty-process-table-parser'

export { parseProcessTable, type ProcessTableRow } from './pty-process-table-parser'
export {
  hasUnambiguousStartIdentity,
  hasUnambiguousStartTime
} from './pty-descendant-signal-targets'
import { runWindowsSweepWithDeadline, type WindowsSweepDeps } from './pty-descendant-sweep-budget'

export const DESCENDANT_KILL_GRACE_MS = 2_000
export const DESCENDANT_SNAPSHOT_TIMEOUT_MS = 1_000
// Busy hosts can exceed execFile’s 1MB default; truncated output would omit descendants.
const PS_MAX_BUFFER_BYTES = 32 * 1024 * 1024

export type PosixProcessIdentity = Pick<ProcessTableRow, 'pid' | 'startedAt'>

export type DescendantSnapshot = {
  root?: PosixProcessIdentity
  rootPgid: number | null
  descendants: ProcessTableRow[]
  /** Wall-clock boundary for an unmerged snapshot (or legacy callers). */
  capturedAtMs: number
  /** Per-PID identity boundaries for merged captures. */
  capturedAtMsByPid?: Readonly<Record<string, number>>
  /** Fresh ancestry proves ownership despite lstart’s second-resolution timestamps; retained merge rows do not. */
  reDerivedPids?: ReadonlySet<number>
}

export type ProcessTableCapture = {
  rows: ProcessTableRow[]
  /** Start boundary of the scan that produced rows, never a later consumer's time. */
  capturedAtMs: number
}

export type ProcessTableReader = (timeoutMs?: number) => Promise<ProcessTableCapture>
export type SignalSender = (pid: number, signal: NodeJS.Signals) => void

function readFreshProcessTable(
  timeoutMs = DESCENDANT_SNAPSHOT_TIMEOUT_MS
): Promise<ProcessTableCapture> {
  // Stamp before ps starts so a capture-second PID cannot appear older after a clock rollover.
  const capturedAtMs = Date.now()
  return new Promise((resolve, reject) => {
    execFile(
      'ps',
      ['-axo', 'pid=,ppid=,pgid=,tpgid=,lstart='],
      {
        maxBuffer: PS_MAX_BUFFER_BYTES,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        // Pin lstart’s locale so delayed identity checks parse it consistently.
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

/** Share only scans not yet started; later requests need fresh identities before signalling. */
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
      // Start each later request’s scan within its own deadline, without queuing behind an older one.
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

export const readProcessTable = createProcessTableSnapshotReader(readFreshProcessTable)

export function collectDescendantRows(
  rootPid: number,
  table: ProcessTableRow[],
  capturedAtMs = Date.now()
): DescendantSnapshot {
  const childrenByPpid = new Map<number, ProcessTableRow[]>()
  let rootRow: ProcessTableRow | null = null
  let duplicateRoot = false
  for (const row of table) {
    if (row.pid === rootPid) {
      // Duplicate root rows from a non-atomic read leave its identity ambiguous.
      duplicateRoot = rootRow !== null
      rootRow ??= row
      continue
    }
    const siblings = childrenByPpid.get(row.ppid)
    if (siblings) {
      siblings.push(row)
    } else {
      childrenByPpid.set(row.ppid, [row])
    }
  }
  // After root exit, descendants reparent; remaining rows with its old PID as parent may reflect PID reuse.
  if (!rootRow || duplicateRoot) {
    return { rootPgid: null, descendants: [], capturedAtMs }
  }
  const descendants: ProcessTableRow[] = []
  const queue = [rootPid]
  const visited = new Set(queue)
  for (let nextIndex = 0; nextIndex < queue.length; nextIndex += 1) {
    const pid = queue[nextIndex]
    for (const child of childrenByPpid.get(pid) ?? []) {
      // Non-atomic ps output can contain duplicate or cyclic rows; never loop on them.
      if (visited.has(child.pid)) {
        continue
      }
      visited.add(child.pid)
      descendants.push(child)
      queue.push(child.pid)
    }
  }
  return {
    root: { pid: rootRow.pid, startedAt: rootRow.startedAt },
    rootPgid: rootRow.pgid,
    descendants,
    capturedAtMs,
    reDerivedPids: new Set(descendants.map((row) => row.pid))
  }
}

type SnapshotDeps = {
  readTable?: ProcessTableReader
  platform?: NodeJS.Platform
  timeoutMs?: number
}

/** Capture before signalling the root: exited parents’ descendants reparent and become unfindable; failure returns null. */
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
  // Bound custom readers too; production execFile separately kills wedged ps processes.
  const capture = await readProcessTableBeforeDeadline(readTable, timeoutMs)
  if (!capture) {
    return null
  }
  return collectDescendantRows(rootPid, capture.rows, capture.capturedAtMs)
}

type KillSweepDeps = Omit<SnapshotDeps & TerminateDeps & WindowsSweepDeps, 'awaitEscalation'> & {
  /** Shutdown can retain the owner until descendant verification finishes. */
  terminateDescendants?: (snapshot: DescendantSnapshot) => void | Promise<unknown>
  awaitEscalation?: boolean | (() => boolean)
}

/**
 * Standard agent-session kill sequencing.
 * - POSIX: snapshot the descendant tree, signal members, then killRoot.
 * - Windows: see runWindowsSweepWithDeadline — the PTY's job object first
 *   (exact, no probe), else the identity-gated `taskkill /T /F` fallback.
 * Callers must not signal the root before this runs on POSIX — a dead root's
 * descendants reparent to pid 1 and become unfindable. Snapshot failure
 * degrades to killRoot alone on POSIX. The default sweep kills the root after
 * identity-checked SIGTERM, before grace. A custom shutdown verifier with
 * awaitEscalation retains the root until its descendant proof finishes.
 */
export async function killWithDescendantSweep(
  rootPid: number,
  killRoot: () => void,
  deps: KillSweepDeps = {}
): Promise<void> {
  const platform = deps.platform ?? process.platform
  if (platform === 'win32') {
    // Why dispatched out: the Windows fallback carries probe scaling, an
    // escalation race, and a killRoot deadline that do not fit this module's
    // line budget. POSIX needs none of that — its snapshot, grace window,
    // and re-read are already constant-bounded.
    await runWindowsSweepWithDeadline(rootPid, killRoot, deps)
    return
  }

  const snapshot = await captureDescendantSnapshot(rootPid, deps)
  let escalation: Promise<void> = Promise.resolve()
  const awaitEscalation =
    typeof deps.awaitEscalation === 'function' ? deps.awaitEscalation() : deps.awaitEscalation
  try {
    // Signal descendants before root death creates a reparent/PID-reuse window.
    if (snapshot && (deps.ownsRoot?.() ?? true)) {
      if (deps.terminateDescendants) {
        const descendants = deps.terminateDescendants(snapshot)
        if (awaitEscalation) {
          await descendants
        }
      } else {
        const started = await startDescendantTermination(
          snapshot,
          { ...deps, awaitEscalation },
          deps.ownsRoot
        )
        escalation = started.escalation
      }
    }
  } finally {
    killRoot()
  }
  if (awaitEscalation) {
    await escalation
  }
}

export function sendDescendantSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch {}
}

export type TerminateDeps = {
  readTable?: ProcessTableReader
  sendSignal?: SignalSender
  graceMs?: number
  /** Independent budget for each signal phase, including transient-read retries. */
  timeoutMs?: number
  /**
   * On POSIX (consumed directly by terminateDescendantSnapshot): await the
   * grace-window SIGKILL escalation before resolving, instead of leaving it
   * on its own unref'd timer. A caller that force-exits the process right
   * after this resolves (daemon shutdown) would otherwise drop that timer
   * mid-flight and leave SIGTERM-ignoring descendants alive. Off by default
   * because it adds up to ~DESCENDANT_KILL_GRACE_MS + DESCENDANT_SNAPSHOT_TIMEOUT_MS
   * of latency, which a long-lived process's fire-and-forget close
   * (interactive tab close) does not need to pay.
   *
   * Also keeps both identity-read deadlines and the grace-window timer
   * ref'd instead of unref'd: an awaiting caller needs Node's event loop to
   * actually stay alive for these to fire, not just a promise nobody's loop
   * is obligated to keep pending. Fire-and-forget callers must leave this
   * unset so an otherwise-idle long-lived process isn't held open by it.
   *
   * On Windows (consumed by killWithDescendantSweep via this same field):
   * keep deadline timers alive while awaiting bounded tree termination. The
   * Windows root remains alive until that termination completes or times out.
   */
  awaitEscalation?: boolean
}

/** Revalidate before both signals; the promise includes the grace-window escalation. */
export async function terminateDescendantSnapshot(
  snapshot: DescendantSnapshot,
  deps: TerminateDeps = {}
): Promise<void> {
  const { escalation } = await startDescendantTermination(snapshot, deps)
  await escalation
}

// Box the escalation promise so callers can kill the root after SIGTERM, before grace.
async function startDescendantTermination(
  snapshot: DescendantSnapshot,
  deps: TerminateDeps,
  ownsRoot?: () => boolean
): Promise<{ escalation: Promise<void> }> {
  const skip = { escalation: Promise.resolve() }
  if (snapshot.descendants.length === 0) {
    return skip
  }
  const sendSignal = deps.sendSignal ?? sendDescendantSignal
  const readTable = deps.readTable ?? readProcessTable
  const keepAlive = deps.awaitEscalation ?? false
  const timeoutMs = deps.timeoutMs ?? DESCENDANT_SNAPSHOT_TIMEOUT_MS
  const graceMs = deps.graceMs ?? DESCENDANT_KILL_GRACE_MS
  // Daemon shutdown supplies its own verifier; interactive escalation gets a full fresh-read budget.
  const initial = await readProcessTableWithRetries(readTable, timeoutMs, keepAlive, ownsRoot)
  if (!initial || !(ownsRoot?.() ?? true)) {
    return skip
  }
  const descendants = matchingSignalTargets(snapshot, initial.rows)
  if (descendants.length === 0) {
    return skip
  }
  for (const row of descendants) {
    sendSignal(row.pid, 'SIGTERM')
  }
  const validatedSnapshot = { ...snapshot, descendants }
  const escalation = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      void readProcessTableWithRetries(readTable, timeoutMs, keepAlive).then((capture) => {
        if (capture) {
          for (const row of matchingSignalTargets(validatedSnapshot, capture.rows)) {
            sendSignal(row.pid, 'SIGKILL')
          }
        }
        resolve()
      })
    }, graceMs)
    if (!keepAlive) {
      timer.unref?.()
    }
  })
  return { escalation }
}
