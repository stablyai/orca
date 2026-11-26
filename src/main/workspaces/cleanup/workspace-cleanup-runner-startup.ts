import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { RuntimeStore } from '../../runtime/construction/runtime-store-contract'
import { WorkspaceCleanupRunner } from './workspace-cleanup-runner'
import { setWorkspaceCleanupRunner } from './workspace-cleanup-runner-registry'

/** Starts the runner for the repos this process owns: desktop main for local/WSL, each orcad for its own. */
export function startWorkspaceCleanupRunner(
  runtime: OrcaRuntimeService,
  store: RuntimeStore
): WorkspaceCleanupRunner | null {
  const historyDirectory = store.getProfileStorageDirectory?.()
  if (!historyDirectory) {
    return null
  }
  const runner = new WorkspaceCleanupRunner({ runtime, store, historyDirectory })
  setWorkspaceCleanupRunner(runtime, runner)
  runner.start()
  return runner
}
