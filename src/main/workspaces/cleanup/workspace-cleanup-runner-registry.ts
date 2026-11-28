import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { WorkspaceCleanupRunner } from './workspace-cleanup-runner'

// Keyed by runtime: desktop main and orcad each own one runner for their own repos.
const runners = new WeakMap<OrcaRuntimeService, WorkspaceCleanupRunner>()
const runnerLoaders = new WeakMap<
  OrcaRuntimeService,
  () => Promise<WorkspaceCleanupRunner | null>
>()

export function setWorkspaceCleanupRunner(
  runtime: OrcaRuntimeService,
  runner: WorkspaceCleanupRunner
): void {
  runners.set(runtime, runner)
}

export function registerWorkspaceCleanupRunnerLoader(
  runtime: OrcaRuntimeService,
  loader: () => Promise<WorkspaceCleanupRunner | null>
): void {
  runnerLoaders.set(runtime, loader)
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

export async function ensureWorkspaceCleanupRunner(
  runtime: OrcaRuntimeService
): Promise<WorkspaceCleanupRunner> {
  const existing = runners.get(runtime)
  if (existing) {
    return existing
  }
  const loader = runnerLoaders.get(runtime)
  if (loader) {
    const loaded = await loader()
    if (loaded) {
      return loaded
    }
  }
  return requireWorkspaceCleanupRunner(runtime)
}
