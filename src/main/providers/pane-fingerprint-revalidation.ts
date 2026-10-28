import { recognizeAgentProcess } from '../../shared/agent-process-recognition'
import { getCheapProcessTableSnapshot } from '../../shared/cheap-process-table-snapshot-reader'
import type { CheapProcessTableRow } from '../../shared/process-table-snapshot'
import {
  buildPaneProcessFingerprint,
  paneFingerprintForegroundGroup
} from './posix-pane-foreground-fingerprint'

/** Every anchored pane rechecks its fingerprint once per shared window, so one capture serves them all. */
export const PANE_FINGERPRINT_REVALIDATION_WINDOW_MS = 10_000

export type RevalidatedPaneFingerprint = {
  fingerprint: string
  /** Window index of the last capture that matched; absent until one has. */
  verifiedWindow?: number
}

export type PaneFingerprintRevalidationDeps = {
  now?: () => number
  readRows?: () => Promise<CheapProcessTableRow[]>
  isAlive?: (pid: number) => boolean
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM still proves the PID exists.
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}

function paneFingerprintWindow(nowMs: number): number {
  return Math.floor(nowMs / PANE_FINGERPRINT_REVALIDATION_WINDOW_MS)
}

/** Mark a fingerprint just read from a full capture as verified for the current window. */
export function markPaneFingerprintVerified(
  anchor: RevalidatedPaneFingerprint,
  nowMs = Date.now()
): void {
  anchor.verifiedWindow = paneFingerprintWindow(nowMs)
}

/**
 * Between captures, an agent that leads the foreground group is unchanged while it is alive and the kernel still names it in the foreground; exit, Ctrl-Z, a tool taking the terminal and a restart each break one of those.
 * Anything subtler is caught at the next window, as a cheap capture always could.
 */
function canReuseWithoutCapture(
  anchor: RevalidatedPaneFingerprint,
  foregroundName: string | null,
  window: number,
  isAlive: (pid: number) => boolean
): boolean {
  if (anchor.verifiedWindow !== window) {
    return false
  }
  // A wrapper leading the group outlives the agent inside it.
  if (!recognizeAgentProcess(foregroundName)) {
    return false
  }
  const leader = paneFingerprintForegroundGroup(anchor.fingerprint)
  return leader !== null && isAlive(leader)
}

/** `foregroundName` is the live raw foreground name, which callers have already matched to the one the anchor was taken with. */
export async function paneFingerprintStillMatches(
  anchor: RevalidatedPaneFingerprint,
  foregroundName: string | null,
  rootPid: number,
  deps: PaneFingerprintRevalidationDeps = {}
): Promise<boolean> {
  const nowMs = (deps.now ?? Date.now)()
  const window = paneFingerprintWindow(nowMs)
  if (canReuseWithoutCapture(anchor, foregroundName, window, deps.isAlive ?? isProcessAlive)) {
    return true
  }
  const observed = await buildPaneProcessFingerprint(
    await (deps.readRows ?? getCheapProcessTableSnapshot)(),
    rootPid
  )
  if (observed === null || observed !== anchor.fingerprint) {
    return false
  }
  anchor.verifiedWindow = window
  return true
}
