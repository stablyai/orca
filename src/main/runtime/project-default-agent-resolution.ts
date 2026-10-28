import type { Repo } from '../../shared/repo-types'
import type { Project } from '../../shared/project-types'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { TuiAgent } from '../../shared/tui-agent'
import { isTuiAgent } from '../../shared/tui-agent-config'
import { pickTuiAgent } from '../../shared/tui-agent-selection'
import {
  getRepoExecutionHostId,
  getSshTargetIdForExecutionHost,
  parseExecutionHostId
} from '../../shared/execution-host'
import { findFolderWorkspaceCandidateRepos } from '../../shared/folder-workspace-execution-host'
import { resolveLocalWorkspaceRuntime } from '../local-project-runtime-resolution'
import { detectAgentsOnHost, type AgentDetectionHost } from '../preflight/workspace-agent-detection'
import type { RuntimeStore } from './runtime-store-contract'

type DefaultAgentRuntime = {
  requireStore: () => Pick<
    RuntimeStore,
    | 'getProjects'
    | 'getProjectHostSetups'
    | 'getRepos'
    | 'getProjectGroups'
    | 'getFolderWorkspaces'
    | 'getWorktreeMeta'
  > & { getSettings?: RuntimeStore['getSettings'] }
  getClientSettings: () => {
    defaultTuiAgent?: TuiAgent | 'blank' | null
    disabledTuiAgents?: readonly TuiAgent[]
  }
  showTerminalWorkspaceLaunchScope: (selector: string) => Promise<{
    id: string
    path: string
    repo: Repo | null
    folderWorkspace: FolderWorkspace | null
  }>
  resolveAgentDetectionHost: (
    worktreeId: string | null | undefined,
    repoId?: string
  ) => Promise<AgentDetectionHost>
}

export type ProjectDefaultAgentResolution = {
  agent: TuiAgent | null
  source: 'project' | 'global' | 'automatic' | 'explicit'
  projectId?: string
  projectName?: string
}

function projectForRepo(
  store: ReturnType<DefaultAgentRuntime['requireStore']>,
  repo: Repo
): Project | undefined {
  const projects = store.getProjects?.() ?? []
  const setups = store.getProjectHostSetups?.() ?? []
  const hostId = getRepoExecutionHostId(repo)
  const ownerIds = new Set(
    setups
      .filter((setup) => setup.repoId === repo.id && setup.hostId === hostId)
      .map((setup) => setup.projectId)
  )
  const matches = projects.filter((project) =>
    ownerIds.size ? ownerIds.has(project.id) : project.sourceRepoIds.includes(repo.id)
  )
  if (matches.length > 1) {
    throw new Error(
      `Target project is ambiguous for repository ${repo.displayName}. Select a host-qualified repository.`
    )
  }
  return matches[0]
}

function projectForFolder(
  store: ReturnType<DefaultAgentRuntime['requireStore']>,
  folder: FolderWorkspace
): Project | undefined {
  const candidates = findFolderWorkspaceCandidateRepos(
    {
      folderWorkspaces: store.getFolderWorkspaces?.() ?? [],
      projectGroups: store.getProjectGroups?.() ?? [],
      repos: store.getRepos()
    },
    folder.id
  )
  const projects = new Map<string, Project>()
  for (const repo of candidates) {
    const project = projectForRepo(store, repo)
    if (project) {
      projects.set(project.id, project)
    }
  }
  if (projects.size > 1) {
    throw new Error(
      `Target project is ambiguous for folder workspace ${folder.name}. Choose an explicit agent.`
    )
  }
  return projects.values().next().value
}

async function detectionHostForRepo(
  store: ReturnType<DefaultAgentRuntime['requireStore']>,
  repo: Repo
): Promise<AgentDetectionHost> {
  const executionHostId = getRepoExecutionHostId(repo)
  const ssh = getSshTargetIdForExecutionHost(executionHostId)
  if (ssh) {
    return { kind: 'ssh', connectionId: ssh }
  }
  if (parseExecutionHostId(executionHostId)?.kind === 'runtime') {
    throw new Error(
      `Target repository ${repo.displayName} belongs to another runtime. Resolve the default on its execution host.`
    )
  }
  const projectRuntime = resolveLocalWorkspaceRuntime(store, repo, repo.path)
  return projectRuntime ? { kind: 'local', context: { projectRuntime } } : { kind: 'local' }
}

export async function resolveProjectDefaultAgent(
  runtime: DefaultAgentRuntime,
  target: { repo?: Repo; worktreeId?: string },
  validateAgent?: TuiAgent
): Promise<ProjectDefaultAgentResolution> {
  if (target.repo && target.worktreeId) {
    throw new Error('Choose a target repository or workspace, not both.')
  }
  const store = runtime.requireStore()
  let project: Project | undefined
  let detectionHost: AgentDetectionHost
  if (target.worktreeId) {
    const scope = await runtime.showTerminalWorkspaceLaunchScope(target.worktreeId)
    const pinnedProjectId = store.getWorktreeMeta(scope.id)?.projectId
    if (pinnedProjectId) {
      project = (store.getProjects?.() ?? []).find((candidate) => candidate.id === pinnedProjectId)
      if (!project) {
        throw new Error(
          `Target project ${pinnedProjectId} for workspace ${scope.id} was not found.`
        )
      }
    } else {
      project = scope.folderWorkspace
        ? projectForFolder(store, scope.folderWorkspace)
        : scope.repo
          ? projectForRepo(store, scope.repo)
          : undefined
    }
    detectionHost = await runtime.resolveAgentDetectionHost(scope.id, scope.repo?.id)
  } else if (target.repo) {
    project = projectForRepo(store, target.repo)
    detectionHost = await detectionHostForRepo(store, target.repo)
  } else {
    detectionHost = { kind: 'local' }
  }

  const settings = runtime.getClientSettings()
  const projectChoice = project?.defaultTuiAgent
  const choice = validateAgent ?? projectChoice ?? settings.defaultTuiAgent
  const source = validateAgent
    ? 'explicit'
    : projectChoice != null
      ? 'project'
      : choice != null
        ? 'global'
        : 'automatic'
  const identity = project ? { projectId: project.id, projectName: project.displayName } : {}
  if (choice === 'blank') {
    return { agent: null, source, ...identity }
  }

  if (choice != null && !isTuiAgent(choice)) {
    throw new Error(
      `Default agent for ${project?.displayName ?? 'this host'}: ${String(choice)} is not a known agent on the execution host. Choose an explicit agent or update the default.`
    )
  }

  const installed = (await detectAgentsOnHost(detectionHost)).filter(isTuiAgent)
  const enabled = new Set(settings.disabledTuiAgents ?? [])
  if (choice != null) {
    if (!installed.includes(choice) || enabled.has(choice)) {
      throw new Error(
        `${validateAgent ? 'Retried agent' : 'Default agent'} for ${project?.displayName ?? 'this host'}: ${choice} is unavailable or disabled on the execution host. Choose an explicit agent or update the default.`
      )
    }
    return { agent: choice, source, ...identity }
  }
  return { agent: pickTuiAgent(null, installed, enabled), source, ...identity }
}
