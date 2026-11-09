import { getRuntimePathBasename } from '../../shared/cross-platform-path'
import { TERMINAL_GIT_CREDENTIAL_GUARD_POLICY_ENV } from '../../shared/shell/launch/terminal-git-credential-guard'
import type { Repo } from '../../shared/repo-types'
import { isFolderRepo } from '../../shared/repo-kind'

/** The workspace a hook runs for; folder workspaces share one directory, so the path can't name them. */
export type HookWorkspaceIdentity = {
  worktreeId: string
  /** Names a folder workspace; a worktree's name is its directory's. */
  displayName?: string
}

// Keep WSL path translation in pty/wsl-orca-env.ts in sync; names and policies are not paths.
export const SETUP_RUNNER_PATH_ENV_KEYS = [
  'ORCA_ROOT_PATH',
  'ORCA_WORKTREE_PATH',
  'CONDUCTOR_ROOT_PATH',
  'GHOSTX_ROOT_PATH'
] as const

export function getSetupEnvVars(
  repo: Repo,
  worktreePath: string,
  identity?: HookWorkspaceIdentity
): Record<string, string> {
  return {
    ORCA_ROOT_PATH: repo.path,
    ORCA_WORKTREE_PATH: worktreePath,
    ORCA_WORKSPACE_NAME:
      identity?.displayName && isFolderRepo(repo)
        ? identity.displayName
        : getRuntimePathBasename(worktreePath),
    // Same values a pane sets, so `orca worktree create` in the hook attaches to this workspace.
    ...(identity
      ? { ORCA_WORKSPACE_ID: identity.worktreeId, ORCA_WORKTREE_ID: identity.worktreeId }
      : {}),
    // Legacy conductor.json compatibility.
    CONDUCTOR_ROOT_PATH: repo.path,
    GHOSTX_ROOT_PATH: repo.path
  }
}

export function getSetupRunnerEnvVars(
  repo: Repo,
  worktreePath: string,
  identity?: HookWorkspaceIdentity
): Record<string, string> {
  return {
    ...getSetupEnvVars(repo, worktreePath, identity),
    // Unattended setup always needs credential protection, regardless of user opt-out.
    [TERMINAL_GIT_CREDENTIAL_GUARD_POLICY_ENV]: 'guard'
  }
}
