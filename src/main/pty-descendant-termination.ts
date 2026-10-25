import { execFile } from 'node:child_process'
import type { JobTerminationOutcome } from './windows/windows-pty-job'
import { terminateWindowsProcessTree, type WindowsTreeKiller } from './windows-process-tree-kill'
import {
  verifyWindowsTreeKillTarget,
  type WindowsTreeKillTarget
} from './windows-pty-root-identity'
import { parseProcessTable, type ProcessTableRow } from './pty-process-table-parser'

export { parseProcessTable, type ProcessTableRow } from './pty-process-table-parser'

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
      ['-axo', 'pid=,ppid=,pgid=,lstart='],
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

export function readProcessTableBeforeDeadline(
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

type KillSweepDeps = SnapshotDeps &
  TerminateDeps & {
    ownsRoot?: () => boolean
    /** Shutdown can retain the owner until descendant escalation finishes. */
    terminateDescendants?: (snapshot: DescendantSnapshot) => void | Promise<unknown>
    awaitEscalation?: boolean | (() => boolean)
    /** unavailable means no owned job exists, not that the tree exited. */
    terminateOwnedTree?: () => JobTerminationOutcome
    killWindowsTree?: WindowsTreeKiller
    verifyTreeKillTarget?: (rootPid: number) => Promise<WindowsTreeKillTarget>
  }

/** Call before killing the root: POSIX needs live ancestry; Windows prefers an owned job, then an identity-gated PID walk. */
export async function killWithDescendantSweep(
  rootPid: number,
  killRoot: () => void,
  deps: KillSweepDeps = {}
): Promise<void> {
  const platform = deps.platform ?? process.platform
  if (platform === 'win32') {
    try {
      if ((deps.ownsRoot?.() ?? true) && Number.isInteger(rootPid) && rootPid > 0) {
        // Owned jobs survive PID reuse and include descendants reparented away from the shell.
        if (deps.terminateOwnedTree?.() === 'terminated') {
          return
        }
        // ConPTY closes the shell handle before JS sees exit; require OS identity to reject recycled PIDs.
        const verify = deps.verifyTreeKillTarget ?? verifyWindowsTreeKillTarget
        const target = await verify(rootPid).catch((): WindowsTreeKillTarget => 'unknown')
        // Re-check ownership: the identity query awaits, so exit can land meanwhile.
        if (target === 'own' && (deps.ownsRoot?.() ?? true)) {
          const killTree =
            deps.killWindowsTree ??
            ((pid: number) => terminateWindowsProcessTree(pid, { site: 'pty-descendant-sweep' }))
          // A taskkill failure must not skip root termination.
          await killTree(rootPid).catch(() => {})
        }
      }
    } finally {
      killRoot()
    }
    return
  }

  const snapshot = await captureDescendantSnapshot(rootPid, deps)
  let descendants: void | Promise<unknown> = undefined
  const awaitEscalation =
    typeof deps.awaitEscalation === 'function' ? deps.awaitEscalation() : deps.awaitEscalation
  if (awaitEscalation) {
    try {
      if (snapshot && (deps.ownsRoot?.() ?? true)) {
        descendants = deps.terminateDescendants
          ? deps.terminateDescendants(snapshot)
          : terminateDescendantSnapshot(snapshot, deps)
      }
      await descendants
    } finally {
      killRoot()
    }
    return
  }
  try {
    // Signal descendants before root death creates a reparent/PID-reuse window.
    if (snapshot && (deps.ownsRoot?.() ?? true)) {
      descendants = deps.terminateDescendants
        ? deps.terminateDescendants(snapshot)
        : terminateDescendantSnapshot(snapshot, deps)
    }
  } finally {
    killRoot()
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
  timeoutMs?: number
}

export function hasUnambiguousStartIdentity(row: ProcessTableRow, capturedAtMs: number): boolean {
  return hasUnambiguousStartTime(row.startedAt, capturedAtMs)
}

export function hasUnambiguousStartTime(startedAt: string, capturedAtMs: number): boolean {
  const startedAtMs = Date.parse(startedAt)
  if (!Number.isFinite(startedAtMs)) {
    return false
  }
  // lstart cannot distinguish PID reuse within the capture second.
  return startedAtMs < Math.floor(capturedAtMs / 1_000) * 1_000
}

/** Reach detached descendants with SIGTERM, then escalate only survivors whose identity excludes same-second PID reuse. */
export function terminateDescendantSnapshot(
  snapshot: DescendantSnapshot,
  deps: TerminateDeps = {}
): void {
  const sendSignal = deps.sendSignal ?? sendDescendantSignal
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
      // Index only the small set of signal targets, not the whole process table.
      for (const live of capture.rows) {
        if (expectedPids.has(live.pid)) {
          // Duplicate PID rows make identity ambiguous, so never escalate them.
          liveTargets.set(live.pid, liveTargets.has(live.pid) ? null : live)
        }
      }
      for (const row of snapshot.descendants) {
        const live = liveTargets.get(row.pid)
        if (
          hasUnambiguousStartIdentity(
            row,
            snapshot.capturedAtMsByPid?.[String(row.pid)] ?? snapshot.capturedAtMs
          ) &&
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
