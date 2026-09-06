import {
  recordRefusedOwnChromiumTreeKill,
  recordSelfInitiatedTreeKill,
  type SelfInitiatedTreeKillScope
} from './crash-reporting/self-initiated-tree-kill-log'
import { readOrcaChromiumProcessPids } from './orca-chromium-process-pids'
import { setProcessTreeKillGate } from '../shared/child-process/process-tree-kill-gate'

/**
 * Gate every main-process tree-kill through one decision: refuse a pid-addressed
 * walk when Electron is currently accounting for the pid, otherwise put the
 * kill on the record.
 *
 * Why a shared gate rather than a check inside `terminateWindowsProcessTree`:
 * five other families in main run their own `taskkill /T /F` with different
 * lifetimes (sync, fire-and-forget, timeout ladder), and three more live in
 * `src/shared` and reach this through `process-tree-kill-gate`, so a guard that
 * only lived in the tree-kill helper would cover one of nine.
 * `main-process-tree-kill-gate.test.ts` holds that set closed by counting `/pid`
 * call sites against gate admissions per file, not by file. Returns false
 * when the caller must not walk that pid's tree; the caller still kills its own
 * root through the child handle (`refused-tree-kill-root-termination.test.ts`),
 * so a refusal is never a process leak.
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
  // the GPU or the browser itself (#10680). Only the pid-addressed scope can
  // land there: a POSIX group holds only what Orca put in it, so that arm is
  // recorded and admitted like every other group kill in main, and a stale
  // `getAppMetrics()` entry cannot orphan a macOS/Linux tree.
  const isOwnChromiumPid =
    target.scope === 'win-taskkill-tree' && readOrcaChromiumProcessPids().has(target.pid)
  try {
    if (isOwnChromiumPid) {
      recordRefusedOwnChromiumTreeKill(target)
    } else {
      recordSelfInitiatedTreeKill(target)
    }
  } catch {
    // Recording must never turn a successful termination into a failed one, and
    // never flip the decision: it is taken above, before anything can throw.
  }
  return !isOwnChromiumPid
}

/** Hands the gate to the shared choke points, which cannot import main. */
export function installMainProcessTreeKillGate(): void {
  setProcessTreeKillGate((kill) => admitSelfInitiatedTreeKill(kill))
}
