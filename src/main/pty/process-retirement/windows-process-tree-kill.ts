import { runWindowsTaskkillOffMain } from '../../git/command-runner/process-capture/spawned-command-tree-kill'
import { admitSelfInitiatedTreeKill } from './own-chromium-tree-kill-guard'

export type WindowsTreeKiller = (rootPid: number, deps?: { site?: string }) => Promise<void>

/** Bound hung taskkill so killRoot still runs in killWithDescendantSweep. */
export const WINDOWS_PROCESS_TREE_KILL_TIMEOUT_MS = 5_000

/** taskkill /t /f for one live tree, started off Electron main where it can be; true only when it ended the tree. Callers check the Chromium-PID guard first. */
export function runWindowsTaskkillTree(
  pid: number,
  timeoutMs: number = WINDOWS_PROCESS_TREE_KILL_TIMEOUT_MS
): Promise<boolean> {
  return runWindowsTaskkillOffMain([pid], timeoutMs)
}

/** Best-effort tree kill; resolves true only when taskkill exits successfully. */
export function terminateWindowsProcessTree(
  rootPid: number,
  deps: { site?: string } = {}
): Promise<boolean> {
  if (!Number.isInteger(rootPid) || rootPid <= 0) {
    return Promise.resolve(false)
  }
  const site = deps.site ?? 'windows-process-tree-kill'
  if (!admitSelfInitiatedTreeKill({ pid: rootPid, site, scope: 'win-taskkill-tree' })) {
    return Promise.resolve(false)
  }
  return runWindowsTaskkillTree(rootPid)
}
