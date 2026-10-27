import { homedir } from 'node:os'
import { getWslHome } from '../wsl'
import { parseWslUncPath } from '../../shared/wsl-paths'
import {
  getConnectionExecutionHostId,
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import type { SkillInstallDestinationAuthority } from '../skills/skill-install-destinations'
import {
  resolveEnvironmentSkillProviderRoots,
  resolveWslSkillProviderRoots,
  withClaudeSkillProviderRoot
} from '../skills/skill-provider-runtime-roots'
import type { SkillInstallRequest } from '../../shared/skill-install-contract'
import type { SkillProviderRootOverrides } from '../skills/skill-provider-destinations'
import type { RuntimeSkillCommandHost } from './runtime-skill-command-contract'

/** Whether the destination lives on an SSH target; a workspace that cannot be placed throws. */
export async function isSkillSshDestination(
  host: RuntimeSkillCommandHost,
  destination: SkillInstallRequest['destination']
): Promise<boolean> {
  if (destination.scope === 'global') {
    return destination.executionTarget?.kind === 'ssh'
  }
  if (destination.worktreeId) {
    const repos = host
      .listRepos()
      .filter((candidate) => candidate.id === getRepoIdFromWorktreeId(destination.worktreeId!))
    const hostIds = new Set(repos.map((repo) => getRepoExecutionHostId(repo)))
    if (hostIds.size > 1) {
      throw new Error('skill-install-workspace-host-ambiguous')
    }
    const executionHost = parseExecutionHostId([...hostIds][0])
    if (!executionHost || executionHost.kind === 'local') {
      return false
    }
    // Non-SSH hosts retain local-path fallthrough; runtime-owned repos must not fail SSH classification.
    if (executionHost.kind !== 'ssh') {
      return false
    }
    // Resolve host-qualified inventory: worktree ids collide and showManagedWorktree lacks the SSH row's hostId.
    const worktrees = (await host.listResolvedWorktrees()).filter(
      (candidate) =>
        candidate.id === destination.worktreeId &&
        (!candidate.hostId || candidate.hostId === executionHost.id)
    )
    if (worktrees.length !== 1) {
      throw new Error(
        worktrees.length > 1
          ? 'skill-install-workspace-host-ambiguous'
          : 'skill-install-workspace-not-found'
      )
    }
    return true
  }
  const folders = host
    .listFolderWorkspaces()
    .filter((candidate) => candidate.id === destination.folderWorkspaceId)
  const folderHosts = new Set(folders.map((folder) => folderExecutionHostId(folder)))
  if (folders.length > 1 || folderHosts.size > 1) {
    throw new Error('skill-install-workspace-host-ambiguous')
  }
  // Only SSH connectionId selected this branch historically; other hosts retain local fallback.
  return Boolean(folders[0]) && parseExecutionHostId([...folderHosts][0])?.kind === 'ssh'
}

export async function resolveSkillProviderRoots(
  host: RuntimeSkillCommandHost,
  destination: {
    scope: 'global' | 'workspace'
    homeDirectory: string
    workspaceDirectory?: string
    wslDistro?: string
  }
): Promise<SkillProviderRootOverrides> {
  if (destination.scope !== 'global') {
    return {}
  }
  const roots = destination.wslDistro
    ? await resolveWslSkillProviderRoots(destination.wslDistro)
    : resolveEnvironmentSkillProviderRoots()
  const config = host.getClaudeConfigDirectory?.(
    destination.wslDistro
      ? { runtime: 'wsl', wslDistro: destination.wslDistro }
      : { runtime: 'host' }
  )
  return withClaudeSkillProviderRoot(roots, config)
}

export function folderExecutionHostId(folder: {
  connectionId?: string | null
  executionHostId?: ExecutionHostId | null
}): ExecutionHostId {
  return (
    normalizeExecutionHostId(folder.executionHostId) ??
    getConnectionExecutionHostId(folder.connectionId)
  )
}

export function createSkillInstallAuthority(
  host: RuntimeSkillCommandHost
): SkillInstallDestinationAuthority {
  return {
    environmentId: host.getRuntimeId(),
    homeDirectory: homedir(),
    resolveWorktree: async (id) => {
      const repos = host
        .listRepos()
        .filter((candidate) => candidate.id === getRepoIdFromWorktreeId(id))
      const hostIds = new Set(repos.map((repo) => getRepoExecutionHostId(repo)))
      if (hostIds.size > 1) {
        throw new Error('skill-install-workspace-host-ambiguous')
      }
      if (hostIds.size === 1 && !hostIds.has(LOCAL_EXECUTION_HOST_ID)) {
        throw new Error('skill-install-ssh-dispatch-required')
      }
      // Let Git/I/O failures propagate rather than misreport a missing workspace.
      const worktree = await host.showManagedWorktree(`id:${id}`)
      if (worktree.id !== id) {
        return null
      }
      const projectRuntime = host.resolveProjectRuntimeForWorktree?.(id)
      return {
        id,
        path: worktree.path,
        ...(projectRuntime?.status === 'resolved' &&
        projectRuntime.runtime?.kind === 'wsl' &&
        projectRuntime.runtime.distro
          ? { wslDistro: projectRuntime.runtime.distro }
          : {})
      }
    },
    resolveFolderWorkspace: async (id) => {
      const workspaces = host.listFolderWorkspaces().filter((candidate) => candidate.id === id)
      if (workspaces.length > 1) {
        throw new Error('skill-install-workspace-host-ambiguous')
      }
      const workspace = workspaces[0]
      if (!workspace) {
        return null
      }
      if (folderExecutionHostId(workspace) !== LOCAL_EXECUTION_HOST_ID) {
        throw new Error('skill-install-ssh-dispatch-required')
      }
      const wsl = parseWslUncPath(workspace.folderPath)
      return { id, path: workspace.folderPath, ...(wsl ? { wslDistro: wsl.distro } : {}) }
    },
    resolveWsl: async (distro) =>
      process.platform === 'win32'
        ? ((homeDirectory) => (homeDirectory ? { homeDirectory } : null))(getWslHome(distro))
        : null
  }
}
