import { execFile } from 'node:child_process'
import { admitSelfInitiatedTreeKill } from './own-chromium-tree-kill-guard'

export type WindowsTreeKiller = (rootPid: number, deps?: { site?: string }) => Promise<void>

/** Bound hung taskkill so killRoot still runs in killWithDescendantSweep. */
export const WINDOWS_PROCESS_TREE_KILL_TIMEOUT_MS = 5_000

/**
 * Force-kill a Windows process and every descendant (`taskkill /T /F`).
 * Best-effort: missing/already-dead roots still resolve so callers can finish
 * their own handle cleanup via killRoot.
 *
 * Nearly every main-process taskkill runs through here; the two account-login
 * teardowns keep their own spawn but share the same gate, so the refusal and the
 * breadcrumb live in `admitSelfInitiatedTreeKill` rather than in this function.
 */
export function terminateWindowsProcessTree(
  rootPid: number,
  deps: { execFileImpl?: typeof execFile; site?: string } = {}
): Promise<void> {
  if (!Number.isInteger(rootPid) || rootPid <= 0) {
    return Promise.resolve()
  }
  const site = deps.site ?? 'windows-process-tree-kill'
  if (!admitSelfInitiatedTreeKill({ pid: rootPid, site, scope: 'win-taskkill-tree' })) {
    return Promise.resolve()
  }
  const run = deps.execFileImpl ?? execFile
  return new Promise((resolve) => {
    run(
      'taskkill',
      ['/pid', String(rootPid), '/T', '/F'],
      {
        // Why: a wedged taskkill must not block killRoot forever (#10004 review).
        timeout: WINDOWS_PROCESS_TREE_KILL_TIMEOUT_MS,
        windowsHide: true
      },
      () => {
        resolve()
      }
    )
  })
}
