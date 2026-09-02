import { homedir } from 'node:os'
import { getWslHome } from '../wsl'
import { parseWslUncPath } from '../../shared/wsl-paths'
import {
  type ExecutionHostId,
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  parseExecutionHostId,
  toSshExecutionHostId
} from '../../shared/execution-host'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import type { IPtyProvider } from '../providers/types'
import type { SkillSshWorkspaceAuthority } from '../../shared/skill-ssh-relay-contract'
import type { SkillInstallDestinationAuthority } from '../skills/skill-install-destinations'
import {
  resolveEnvironmentSkillProviderRoots,
  resolveWslGrokSkillProviderRoot,
  withClaudeSkillProviderRoot
} from '../skills/skill-provider-runtime-roots'
import type { SkillInstallRequest, SkillProviderRootOverrides } from './runtime-skill-types'
import type { RuntimeSkillCommandHost } from './runtime-skill-command-surface'

export async function resolveSkillSshTarget(
  host: RuntimeSkillCommandHost,
  destination: SkillInstallRequest['destination'],
  requireSsh: (connectionId: string) => IPtyProvider
): Promise<{ provider: () => IPtyProvider; workspace?: SkillSshWorkspaceAuthority } | null> {
  if (destination.scope === 'global') {
    const target = destination.executionTarget
    return target?.kind === 'ssh' ? { provider: () => requireSsh(target.connectionId) } : null
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
      return null
    }
    // Why null and not a throw: base treated any non-ssh host as "not an SSH install" and
    // fell through to the local path; a runtime-owned repo must not hard-error here.
    if (executionHost.kind !== 'ssh') {
      return null
    }
    // Why the resolved inventory and not showManagedWorktree: a worktree id can collide across
    // hosts, and only this list carries the hostId needed to pick the SSH-owned row.
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
    const worktree = worktrees[0]
    return {
      provider: () => requireSsh(executionHost.targetId),
      workspace: { kind: 'worktree', id: worktree.id, path: worktree.path }
    }
  }
  const folders = host
    .listFolderWorkspaces()
    .filter((candidate) => candidate.id === destination.folderWorkspaceId)
  const folderHosts = new Set(folders.map((folder) => folderExecutionHostId(folder)))
  if (folders.length > 1 || folderHosts.size > 1) {
    throw new Error('skill-install-workspace-host-ambiguous')
  }
  const folder = folders[0]
  const executionHost = parseExecutionHostId([...folderHosts][0])
  if (!folder || !executionHost || executionHost.kind === 'local') {
    return null
  }
  // Why null: base gated this branch on `folder.connectionId`, so any non-ssh host simply
  // was not an SSH install and fell through to the local path.
  if (executionHost.kind !== 'ssh') {
    return null
  }
  return {
    provider: () => requireSsh(executionHost.targetId),
    workspace: { kind: 'folder', id: folder.id, path: folder.folderPath }
  }
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
  const grok = destination.wslDistro
    ? await resolveWslGrokSkillProviderRoot(destination.wslDistro)
    : null
  const roots = destination.wslDistro
    ? grok
      ? { grok }
      : {}
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
    (folder.connectionId ? toSshExecutionHostId(folder.connectionId) : LOCAL_EXECUTION_HOST_ID)
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
      // Why no catch: swallowing here reports a transient git/IO failure as a missing
      // workspace and loses the real cause.
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
