import type { Repo } from '../../../shared/repo-types'
import { parseWslUncPath } from '../../../shared/wsl-paths'
import type { ProjectRuntimeResolutionStore } from '../../local-project-runtime-resolution'
import { resolveLocalProjectRuntimeForRepo } from '../../project-runtime-git-options'

export type WorkerLocalPlacement = { path: string; wsl?: { distro: string } }

/** Where a worker for this workspace runs when that is this host; null for SSH or another host. */
export function resolveWorkerLocalPlacement(
  store: ProjectRuntimeResolutionStore,
  workspace: { path?: string; connectionId?: string | null; repo?: Repo | null } | null
): WorkerLocalPlacement | null {
  const executionRepo = workspace?.repo
  if (
    !workspace?.path ||
    workspace.connectionId ||
    (executionRepo?.executionHostId && executionRepo.executionHostId !== 'local')
  ) {
    return null
  }
  const projectRuntime = executionRepo
    ? resolveLocalProjectRuntimeForRepo(store, executionRepo)
    : null
  if (projectRuntime?.status === 'repair-required') {
    return null
  }
  const unc = parseWslUncPath(workspace.path)
  const wsl = unc
    ? { distro: unc.distro }
    : projectRuntime?.runtime.kind === 'wsl'
      ? { distro: projectRuntime.runtime.distro }
      : undefined
  return { path: workspace.path, ...(wsl ? { wsl } : {}) }
}
