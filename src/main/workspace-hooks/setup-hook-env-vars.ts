import { getRuntimePathBasename } from '../../shared/cross-platform-path'
import { TERMINAL_GIT_CREDENTIAL_GUARD_POLICY_ENV } from '../../shared/shell/launch/terminal-git-credential-guard'
import type { WorkspaceHookOwner } from '../../shared/workspace-hook-owner'
import { isFolderRepo } from '../../shared/repo-kind'

/** The workspace a hook runs for; folder workspaces share one directory, so the path can't name them. */
export type HookWorkspaceIdentity = {
  worktreeId: string
  /** Names a folder workspace; a worktree's name is its directory's. */
  displayName?: string
  workspacePath?: string
}

// Path-valued keys only, so WSL and posix-shell launches translate them; names are not paths.
export const SETUP_RUNNER_PATH_ENV_KEYS = [
  'ORCA_ROOT_PATH',
  'ORCA_WORKTREE_PATH',
  'CONDUCTOR_ROOT_PATH',
  'CONDUCTOR_WORKSPACE_PATH',
  'GHOSTX_ROOT_PATH'
] as const

export function getSetupEnvVars(
  repo: Pick<WorkspaceHookOwner, 'path' | 'kind'>,
  worktreePath: string,
  identity?: HookWorkspaceIdentity
): Record<string, string> {
  worktreePath = identity?.workspacePath ?? worktreePath
  const workspaceName =
    identity?.displayName && isFolderRepo(repo)
      ? identity.displayName
      : getRuntimePathBasename(worktreePath)
  return {
    ORCA_ROOT_PATH: repo.path,
    ORCA_WORKTREE_PATH: worktreePath,
    ORCA_WORKSPACE_NAME: workspaceName,
    // Same values a pane sets, so `orca worktree create` in the hook attaches to this workspace.
    ...(identity
      ? { ORCA_WORKSPACE_ID: identity.worktreeId, ORCA_WORKTREE_ID: identity.worktreeId }
      : {}),
    // Imported Conductor scripts read these names.
    CONDUCTOR_ROOT_PATH: repo.path,
    CONDUCTOR_WORKSPACE_PATH: worktreePath,
    CONDUCTOR_WORKSPACE_NAME: workspaceName,
    GHOSTX_ROOT_PATH: repo.path
  }
}

export function getSetupRunnerEnvVars(
  repo: WorkspaceHookOwner,
  worktreePath: string,
  identity?: HookWorkspaceIdentity
): Record<string, string> {
  return {
    ...getSetupEnvVars(repo, worktreePath, identity),
    // Unattended setup always needs credential protection, regardless of user opt-out.
    [TERMINAL_GIT_CREDENTIAL_GUARD_POLICY_ENV]: 'guard'
  }
}
