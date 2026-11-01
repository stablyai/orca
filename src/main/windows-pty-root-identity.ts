import { queryWindowsProcessLinksFresh } from './providers/windows-foreground-process-rows'
import { readOrcaChromiumProcessPids } from './orca-chromium-process-pids'

/** `own` proves ancestry, not PTY identity: a recycled PID under another Orca child still qualifies. */
export type WindowsTreeKillTarget = 'own' | 'absent' | 'foreign' | 'unknown'

export const WINDOWS_ROOT_IDENTITY_TIMEOUT_MS = 3_000

// Allow the extra winpty-agent hop used below Windows build 18309.
const MAX_ANCESTOR_HOPS = 4

type ProcessLink = { pid: number; ppid: number }

export type WindowsProcessLinkReader = () => Promise<readonly ProcessLink[] | null>

export function classifyWindowsTreeKillTarget(
  rootPid: number,
  rows: readonly ProcessLink[],
  ownerPid: number,
  ownChromiumPids: ReadonlySet<number> = readOrcaChromiumProcessPids()
): WindowsTreeKillTarget {
  // Never let a corrupt root PID authorize killing Orca itself.
  if (!Number.isInteger(rootPid) || rootPid <= 0 || rootPid === ownerPid) {
    return 'foreign'
  }
  // Chromium children also reach ownerPid, but must never qualify for PTY teardown.
  if (ownChromiumPids.has(rootPid)) {
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
    // A chain ending elsewhere does not belong to this live owner.
    if (parent === undefined) {
      return 'foreign'
    }
    if (parent === ownerPid) {
      return 'own'
    }
    if (visited.has(parent)) {
      // Cycles in a changing process table cannot prove ownership.
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

/** Unavailable or timed-out process queries return `unknown`, which must not authorize a tree kill. */
export async function verifyWindowsTreeKillTarget(
  rootPid: number,
  deps: {
    readRows?: WindowsProcessLinkReader
    ownerPid?: number
    ownChromiumPids?: ReadonlySet<number>
    platform?: NodeJS.Platform
    timeoutMs?: number
  } = {}
): Promise<WindowsTreeKillTarget> {
  if ((deps.platform ?? process.platform) !== 'win32') {
    return 'unknown'
  }
  const rows = await readLinksBeforeDeadline(
    deps.readRows ?? queryWindowsProcessLinksFresh,
    deps.timeoutMs ?? WINDOWS_ROOT_IDENTITY_TIMEOUT_MS
  )
  if (!rows) {
    return 'unknown'
  }
  return classifyWindowsTreeKillTarget(
    rootPid,
    rows,
    deps.ownerPid ?? process.pid,
    deps.ownChromiumPids ?? readOrcaChromiumProcessPids()
  )
}
