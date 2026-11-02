import { setSpawnObserver } from '@orca/process-host/spawn-observer'
import {
  isMainThreadDiagnosticsEnabled,
  recordSubprocessSpawn
} from '../diagnostics/main-thread-churn-probe'
import { isWslSpawnTraceEnabled, traceWslSpawn } from '../wsl/wsl-spawn-trace'

/** Main's process-host spawn observer; installed only when a diagnostic wants it, so spawns stay unmeasured otherwise. */
export function installMainSpawnObserver(): void {
  const churn = isMainThreadDiagnosticsEnabled()
  const wslTrace = isWslSpawnTraceEnabled()
  if (!churn && !wslTrace) {
    return
  }
  setSpawnObserver((command, args, blockMs) => {
    if (wslTrace) {
      traceWslSpawn('process-host', command, args)
    }
    // Include process-host spawns too; Git-only probe sites miss rg/ps/PTY helpers.
    if (churn) {
      recordSubprocessSpawn(command, args, blockMs)
    }
  })
}
