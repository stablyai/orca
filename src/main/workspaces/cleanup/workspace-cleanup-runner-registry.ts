import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { WorkspaceCleanupRunner } from './workspace-cleanup-runner'

// Keyed by runtime: desktop main and orcad each own one runner for their own repos.
const runners = new WeakMap<OrcaRuntimeService, WorkspaceCleanupRunner>()

export function setWorkspaceCleanupRunner(
  runtime: OrcaRuntimeService,
  runner: WorkspaceCleanupRunner
): void {
  runners.set(runtime, runner)
}

export function getWorkspaceCleanupRunner(
  runtime: OrcaRuntimeService
): WorkspaceCleanupRunner | undefined {
  return runners.get(runtime)
}

export function requireWorkspaceCleanupRunner(runtime: OrcaRuntimeService): WorkspaceCleanupRunner {
  const runner = runners.get(runtime)
  if (!runner) {
    throw new Error('Workspace cleanup is not running on this host.')
  }
  return runner
}
