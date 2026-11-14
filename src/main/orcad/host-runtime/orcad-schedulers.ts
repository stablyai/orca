import type { Store } from '../../persistence/loading-store/store'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { startWorkspaceCleanupRunner } from '../../workspaces/cleanup/workspace-cleanup-runner-startup'
import { getWorkspaceCleanupRunner } from '../../workspaces/cleanup/workspace-cleanup-runner-registry'
import { orcadAutomationsKeepHostBusy, startOrcadAutomations } from './orcad-automations'

/** The host's own background jobs: automation schedules and workspace cleanup rules. */
export function startOrcadSchedulers(
  runtime: OrcaRuntimeService,
  store: Store,
  registerCleanup: (cleanup: () => void) => void
): void {
  startOrcadAutomations(runtime, store, registerCleanup)
  const cleanupRunner = startWorkspaceCleanupRunner(runtime, store)
  registerCleanup(() => cleanupRunner?.stop())
}

/** A cleanup run mid-removal must finish before idle exit, like a pending automation run. */
export function orcadSchedulersKeepHostBusy(runtime: OrcaRuntimeService, store: Store): boolean {
  return (
    orcadAutomationsKeepHostBusy(store) || getWorkspaceCleanupRunner(runtime)?.isRunning() === true
  )
}
