import { queryWindowsProcessRowsFresh } from './providers/windows-foreground-process-rows'

/**
 * Whether a PID still sits inside this process's own subtree. Note this is
 * subtree membership, not root identity: a recycled PID that lands on any other
 * Orca descendant also reads `own`. It bounds the blast radius of a bad
 * `taskkill /T /F` to our own tree; it does not prove we spawned this PTY.
 * - `own`: ancestry reaches us, so the tree is eligible for guarded teardown.
 * - `absent`: the PID is gone; `taskkill` would no-op anyway.
 * - `foreign`: the PID resolves to a process we did not start (PID recycle).
 * - `unknown`: no usable evidence; callers must not force-kill the tree.
 */
export type WindowsTreeKillTarget = 'own' | 'absent' | 'foreign' | 'unknown'

export const WINDOWS_ROOT_IDENTITY_TIMEOUT_MS = 3_000

// Why: ConPTY spawns the shell directly from this process (1 hop). node-pty falls
// back to winpty below Windows build 18309, which adds a winpty-agent.exe hop.
const MAX_ANCESTOR_HOPS = 4

type ProcessLink = { pid: number; ppid: number }

export type WindowsProcessLinkReader = () => Promise<readonly ProcessLink[] | null>

/**
 * Classify `rootPid` by walking its ancestry back to `ownerPid`. A recycled PID
 * usually belongs to an unrelated process whose chain never passes through Orca,
 * so it resolves `foreign` and must never reach `taskkill /T /F`. Ambiguous
 * tables resolve `unknown` because ambiguity is not evidence of ownership.
 *
 * Known limit (#10680): a recycle that lands on one of our OWN descendants —
 * another pane's shell, an agent CLI, a `git.exe` we spawned — still reads
 * `own`. That is not remote during teardown, when Orca is itself the process
 * allocating pids. Closing it needs real identity (a `Win32_Process.CreationDate`
 * baseline, the analogue of the POSIX `lstart` check, or an inherited handle /
 * Job Object).
 */
export function classifyWindowsTreeKillTarget(
  rootPid: number,
  rows: readonly ProcessLink[],
  ownerPid: number
): WindowsTreeKillTarget {
  // Why: our own pid is never a PTY root, so reading it here means the pid is
  // corrupt. `foreign` is the refusing verdict, which is what that must get —
  // `taskkill /T /F` on ourselves would take Orca and every pane down with it.
  if (!Number.isInteger(rootPid) || rootPid <= 0 || rootPid === ownerPid) {
    return 'foreign'
  }
  const parentByPid = new Map<number, number | null>()
  for (const row of rows) {
    // Duplicate PID rows make ancestry ambiguous, so they never prove ownership.
    parentByPid.set(row.pid, parentByPid.has(row.pid) ? null : row.ppid)
  }
  if (!parentByPid.has(rootPid)) {
    return 'absent'
  }

  const visited = new Set<number>([rootPid])
  let current = rootPid
  for (let hop = 0; hop < MAX_ANCESTOR_HOPS; hop += 1) {
    const parent = parentByPid.get(current)
    if (parent === null) {
      return 'unknown'
    }
    // Why: a chain that dead-ends elsewhere is positive evidence the PID is not
    // ours. Only our own live PID can terminate a chain that started at our child.
    if (parent === undefined) {
      return 'foreign'
    }
    if (parent === ownerPid) {
      return 'own'
    }
    if (visited.has(parent)) {
      // An inconsistent table (mid-scan PID reuse) proves nothing either way.
      return 'unknown'
    }
    visited.add(parent)
    current = parent
  }
  return 'foreign'
}

function readLinksBeforeDeadline(
  readRows: WindowsProcessLinkReader,
  timeoutMs: number
): Promise<readonly ProcessLink[] | null> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (rows: readonly ProcessLink[] | null): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      resolve(rows)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    timer.unref?.()
    try {
      void readRows().then(
        (rows) => finish(rows),
        () => finish(null)
      )
    } catch {
      finish(null)
    }
  })
}

/**
 * Verify that `rootPid` still identifies the PTY root this process started,
 * before a `taskkill /T /F` that would otherwise force-kill a recycled PID and
 * its whole descendant tree. Never rejects: an unavailable or slow process query
 * resolves `unknown`, which is not permission to force-kill the tree.
 */
export async function verifyWindowsTreeKillTarget(
  rootPid: number,
  deps: {
    readRows?: WindowsProcessLinkReader
    ownerPid?: number
    platform?: NodeJS.Platform
    timeoutMs?: number
  } = {}
): Promise<WindowsTreeKillTarget> {
  // Why: the CIM/wmic probes exist only on Windows, so there is nothing to verify
  // off-platform — including suites that drive the win32 branch from POSIX.
  if ((deps.platform ?? process.platform) !== 'win32') {
    return 'unknown'
  }
  const rows = await readLinksBeforeDeadline(
    deps.readRows ?? queryWindowsProcessRowsFresh,
    deps.timeoutMs ?? WINDOWS_ROOT_IDENTITY_TIMEOUT_MS
  )
  if (!rows) {
    return 'unknown'
  }
  return classifyWindowsTreeKillTarget(rootPid, rows, deps.ownerPid ?? process.pid)
}
