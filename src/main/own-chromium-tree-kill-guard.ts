import {
  recordRefusedOwnChromiumTreeKill,
  recordSelfInitiatedTreeKill,
  type SelfInitiatedTreeKillScope
} from './crash-reporting/self-initiated-tree-kill-log'
import { readOrcaChromiumProcessPids } from './orca-chromium-process-pids'
import { setProcessTreeKillGate } from '@orca/process-host/process-tree-kill-gate'

/** Refusal forbids only the PID-based tree walk; callers must still kill the root through its handle. */
export function admitSelfInitiatedTreeKill(target: {
  pid: number
  site: string
  scope: SelfInitiatedTreeKillScope
}): boolean {
  // Windows PID reuse can target Chromium; POSIX groups contain only processes assigned to them (#10680).
  const isOwnChromiumPid =
    target.scope === 'win-taskkill-tree' && readOrcaChromiumProcessPids().has(target.pid)
  try {
    if (isOwnChromiumPid) {
      recordRefusedOwnChromiumTreeKill(target)
    } else {
      recordSelfInitiatedTreeKill(target)
    }
  } catch {
    // Recording failures must neither interrupt termination nor change the guard’s decision.
  }
  return !isOwnChromiumPid
}

/** Shared kill sites cannot import main; install the same guard through their hook. */
export function installMainProcessTreeKillGate(): void {
  setProcessTreeKillGate((kill) => admitSelfInitiatedTreeKill(kill))
}
