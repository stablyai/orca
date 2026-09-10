import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, parse, relative, resolve, sep } from 'node:path'
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

/** Whether `path` is `root` or lies inside it. `sep` is this machine's, and
 *  this module only ever runs on the machine that owns the filesystem. */
function isContained(root: string, path: string): boolean {
  const child = relative(resolve(root), resolve(path))
  return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

/**
 * A workspace destination has to be a workspace, not just any directory the
 * caller named.
 *
 * The incumbent check was `requireContained(workspaceDirectory,
 * workspaceDirectory)`, which is true by construction and so asserted nothing:
 * whatever `path` the request carried became the install root on the execution
 * host (#18273, threat model TM-04/TM-11). These rules are the ones that hold
 * for every host without a workspace catalog to consult; the SSH relay adds a
 * Git proof on top for worktrees.
 */
function requireWorkspaceDirectory(homeDirectory: string, workspaceDirectory: string): void {
  const home = resolve(homeDirectory)
  const workspace = resolve(workspaceDirectory)
  // A filesystem root, the home tree itself, or anything containing the home
  // tree is not a workspace — installing there scatters `.agents` across the
  // user's whole account instead of one checkout.
  if (workspace === parse(workspace).root || workspace === home || isContained(workspace, home)) {
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
  requireWorkspaceDirectory(homeDirectory, workspaceDirectory)
  return {
    scope: 'workspace',
    homeDirectory,
    workspaceDirectory,
    destinationIdentity: `workspace:${authority.environmentId}:${workspace.id}`,
    ...(workspace.wslDistro ? { wslDistro: workspace.wslDistro } : {})
  }
}
