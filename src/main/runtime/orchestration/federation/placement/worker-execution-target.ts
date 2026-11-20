import type { Project, ProjectHostSetup } from '../../../../../shared/project/project-types'
import type { Repo } from '../../../../../shared/repository/repo-types'
import { ALL_TUI_AGENTS } from '../../../../../shared/agent-launch/catalog/tui-agent-display-names'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import type { WorkerExecutionTarget } from '../../../../../shared/project/host-setup/worker-execution-target'
import { isOriginalRepoOnCatalogHost } from '../../../../../shared/execution-host/execution-host'
import { executionRuntimePlatform } from '../../../../../shared/agent-launch/startup/agent-launch-runtime'
import {
  effectiveAgentLaunchProjectRuntime,
  newWorktreeLaunchScope
} from '../../../terminal/launch/agent-launch-scope-runtime'
import { resolveLocalWorkspaceRuntime } from '../../../../workspaces/execution-host/local-project-runtime-resolution'
import { getCachedWslDistros, hasCachedWslDistros } from '../../../../wsl/discovery/distro-catalog'
import type { RuntimeStore } from '../../../construction/runtime-store-contract'

type TargetStore = Pick<RuntimeStore, 'getSettings' | 'getProjects'>

export function projectSetupsWithWorkerExecutionTargets(
  store: TargetStore,
  repos: readonly Repo[],
  setups: readonly ProjectHostSetup[]
): (ProjectHostSetup & { workerExecutionTarget: WorkerExecutionTarget })[] {
  const settings = store.getSettings()
  const reposById = new Map<string, Repo | null>()
  for (const repo of repos) {
    reposById.set(repo.id, reposById.has(repo.id) ? null : repo)
  }
  const sourceProjects = new Map<string, Project>()
  const projectsByRepo = new Map<string, Project | null>()
  const associate = (id: string, project: Project): void => {
    const previous = projectsByRepo.get(id)
    if (previous !== project) {
      projectsByRepo.set(id, previous === undefined ? project : null)
    }
  }
  for (const project of store.getProjects?.() ?? []) {
    associate(project.id, project)
    for (const repoId of project.sourceRepoIds) {
      sourceProjects.set(repoId, project)
      associate(repoId, project)
    }
  }
  const distros = hasCachedWslDistros() ? new Set(getCachedWslDistros() ?? []) : undefined
  const targets = new Map<string, WorkerExecutionTarget>()
  const scopesByProject = new Map<Project, Map<string, WorkerExecutionTarget>>()
  return setups.map((setup) => {
    const repo = reposById.get(setup.repoId)
    const project = projectsByRepo.get(setup.repoId)
    let target: WorkerExecutionTarget = { kind: 'unknown' }
    if (
      repo &&
      project &&
      project.id === setup.projectId &&
      setup.hostId === 'local' &&
      isOriginalRepoOnCatalogHost(setup) &&
      isOriginalRepoOnCatalogHost(repo)
    ) {
      target = targets.get(repo.id) ?? resolveTarget(repo, project)
      targets.set(repo.id, target)
    }
    return { ...setup, workerExecutionTarget: target }
  })

  function resolveTarget(repo: Repo, project: Project): WorkerExecutionTarget {
    const scope = newWorktreeLaunchScope(repo, settings)
    // The scalar launch resolver sees the same association without rescanning every project/membership.
    const member = sourceProjects.get(repo.id) === project
    const key = JSON.stringify([scope.path, member])
    const scopes = scopesByProject.get(project) ?? new Map<string, WorkerExecutionTarget>()
    scopesByProject.set(project, scopes)
    const previous = scopes.get(key)
    if (previous) {
      return previous
    }
    const indexedProject = { ...project, sourceRepoIds: member ? [repo.id] : [] }
    const runtime = resolveLocalWorkspaceRuntime(
      { getProjects: () => [indexedProject], getSettings: () => settings },
      repo,
      scope.path,
      distros
    )
    if (!runtime || runtime.status === 'repair-required') {
      const target: WorkerExecutionTarget = { kind: 'unknown' }
      scopes.set(key, target)
      return target
    }
    const agents: readonly (TuiAgent | undefined)[] = [undefined, ...ALL_TUI_AGENTS]
    const targets = agents.map((agent) => {
      const effective = effectiveAgentLaunchProjectRuntime(runtime, scope.path, !member, agent)
      const platform = executionRuntimePlatform(effective, scope.path, process.platform)
      return process.platform === 'win32' && platform === 'linux' ? 'wsl' : 'native'
    })
    const target: WorkerExecutionTarget = {
      kind: targets.every((target) => target === targets[0]) ? targets[0] : 'unknown'
    }
    scopes.set(key, target)
    return target
  }
}
