import { execFile } from 'node:child_process'

export type WindowsTreeKiller = (rootPid: number) => Promise<void>

/** Bound hung taskkill so killRoot still runs in killWithDescendantSweep. */
export const WINDOWS_PROCESS_TREE_KILL_TIMEOUT_MS = 5_000

/**
 * Force-kill a Windows process and every descendant (`taskkill /T /F`).
 * Best-effort: missing/already-dead roots still resolve so callers can finish
 * their own handle cleanup via killRoot.
 */
export function terminateWindowsProcessTree(
  rootPid: number,
  deps: { execFileImpl?: typeof execFile } = {}
): Promise<void> {
  if (!Number.isInteger(rootPid) || rootPid <= 0) {
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
