import { execFile } from 'node:child_process'
import { admitSelfInitiatedTreeKill } from './own-chromium-tree-kill-guard'

export type WindowsTreeKiller = (rootPid: number, deps?: { site?: string }) => Promise<void>

/** Bound hung taskkill so killRoot still runs in killWithDescendantSweep. */
export const WINDOWS_PROCESS_TREE_KILL_TIMEOUT_MS = 5_000

/** Best-effort tree kill; resolves true only when taskkill exits successfully. */
export function terminateWindowsProcessTree(
  rootPid: number,
  deps: { execFileImpl?: typeof execFile; site?: string } = {}
): Promise<boolean> {
  if (!Number.isInteger(rootPid) || rootPid <= 0) {
    return Promise.resolve(false)
  }
  const site = deps.site ?? 'windows-process-tree-kill'
  if (!admitSelfInitiatedTreeKill({ pid: rootPid, site, scope: 'win-taskkill-tree' })) {
    return Promise.resolve(false)
  }
  const run = deps.execFileImpl ?? execFile
  return new Promise((resolve) => {
    run(
      'taskkill',
      ['/pid', String(rootPid), '/T', '/F'],
      {
        timeout: WINDOWS_PROCESS_TREE_KILL_TIMEOUT_MS,
        windowsHide: true
      },
      (error) => {
        resolve(error === null)
      }
    )
  })
}
