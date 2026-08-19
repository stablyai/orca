import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { SkillInstallRequest } from '../../shared/skill-install-contract'

type WorkspaceIdentity = {
  id: string
  path: string
  wslDistro?: string
}

export type SkillInstallDestinationAuthority = {
  environmentId: string
  homeDirectory: string
  resolveWorktree(id: string): Promise<WorkspaceIdentity | null>
  resolveFolderWorkspace(id: string): Promise<WorkspaceIdentity | null>
  resolveWsl?(distro: string): Promise<{ homeDirectory: string } | null>
}

export type ResolvedSkillInstallDestination = {
  scope: 'global' | 'workspace'
  homeDirectory: string
  workspaceDirectory?: string
  destinationIdentity: string
  wslDistro?: string
}

async function requireDirectory(path: string, category: string): Promise<string> {
  const stat = await lstat(path).catch(() => null)
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(category)
  }
  return realpath(path)
}

function requireContained(root: string, path: string): void {
  const child = relative(resolve(root), resolve(path))
  if (
    child === '..' ||
    child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(child)
  ) {
    throw new Error('skill-install-destination-escape')
  }
}

export async function resolveSkillInstallDestination(
  destination: SkillInstallRequest['destination'],
  authority: SkillInstallDestinationAuthority
): Promise<ResolvedSkillInstallDestination> {
  const homeDirectory = await requireDirectory(
    authority.homeDirectory,
    'skill-install-home-unavailable'
  )
  if (destination.scope === 'global') {
    if (destination.environmentId && destination.environmentId !== authority.environmentId) {
      throw new Error('skill-install-environment-mismatch')
    }
    if (destination.executionTarget?.kind === 'wsl') {
      const wsl = await authority.resolveWsl?.(destination.executionTarget.distro)
      if (!wsl) {
        throw new Error('skill-install-wsl-unavailable')
      }
      return {
        scope: 'global',
        homeDirectory: await requireDirectory(
          wsl.homeDirectory,
          'skill-install-wsl-home-unavailable'
        ),
        destinationIdentity: `global:${authority.environmentId}:wsl:${destination.executionTarget.distro}`,
        wslDistro: destination.executionTarget.distro
      }
    }
    if (destination.executionTarget?.kind === 'ssh') {
      throw new Error('skill-install-ssh-dispatch-required')
    }
    return {
      scope: 'global',
      homeDirectory,
      destinationIdentity: `global:${authority.environmentId}`
    }
  }

  const workspace = destination.worktreeId
    ? await authority.resolveWorktree(destination.worktreeId)
    : await authority.resolveFolderWorkspace(destination.folderWorkspaceId!)
  const expectedId = destination.worktreeId ?? destination.folderWorkspaceId
  if (!workspace || workspace.id !== expectedId) {
    throw new Error('skill-install-workspace-not-found')
  }
  const workspaceDirectory = await requireDirectory(
    workspace.path,
    'skill-install-workspace-unavailable'
  )
  requireContained(workspaceDirectory, workspaceDirectory)
  return {
    scope: 'workspace',
    homeDirectory,
    workspaceDirectory,
    destinationIdentity: `workspace:${authority.environmentId}:${workspace.id}`,
    ...(workspace.wslDistro ? { wslDistro: workspace.wslDistro } : {})
  }
}
