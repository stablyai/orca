import {
  recordRefusedOwnChromiumTreeKill,
  recordSelfInitiatedTreeKill,
  type SelfInitiatedTreeKillScope
} from './crash-reporting/self-initiated-tree-kill-log'
import { readOrcaChromiumProcessPids } from './orca-chromium-process-pids'

/**
 * Gate every main-process tree-kill through one decision: refuse the pid when
 * Electron is currently accounting for it, otherwise put it on the record.
 *
 * Why a shared gate rather than a check inside `terminateWindowsProcessTree`:
 * the codex and claude account-login teardowns run their own `taskkill /T /F`
 * with different lifetimes (one sync, one with its own timeout ladder), so a
 * guard that only lived in the tree-kill helper would cover one of three
 * families. Returns false when the caller must not kill.
 *
 * Electron main only, by construction. `terminateWindowsProcessTree` also runs
 * in the standalone daemon (the `pty-descendant-sweep` site), where
 * `readOrcaChromiumProcessPids()` is empty and this always admits. That is not
 * the gap it looks like: the daemon reaches that taskkill only through
 * `classifyWindowsTreeKillTarget`, whose ancestry walk ends at the daemon's own
 * pid, and no Chromium process descends from the daemon. See
 * `orca-chromium-process-pids.ts`.
 */
export function admitSelfInitiatedTreeKill(target: {
  pid: number
  site: string
  scope: SelfInitiatedTreeKillScope
}): boolean {
  // Why: no PTY root, codex root or git child is ever one of our own Chromium
  // processes, so a pid that is means the caller is about to kill a renderer,
  // the GPU or the browser itself (#10680).
  if (readOrcaChromiumProcessPids().has(target.pid)) {
    recordRefusedOwnChromiumTreeKill(target)
    return false
  }
  recordSelfInitiatedTreeKill(target)
  return true
}
