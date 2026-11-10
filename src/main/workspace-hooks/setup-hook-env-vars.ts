import { getRuntimePathBasename } from '../../shared/cross-platform-path'
import { TERMINAL_GIT_CREDENTIAL_GUARD_POLICY_ENV } from '../../shared/shell/launch/terminal-git-credential-guard'
import type { Repo } from '../../shared/repo-types'

// Path-valued keys only, so WSL and posix-shell launches translate them; names are not paths.
export const SETUP_RUNNER_PATH_ENV_KEYS = [
  'ORCA_ROOT_PATH',
  'ORCA_WORKTREE_PATH',
  'CONDUCTOR_ROOT_PATH',
  'CONDUCTOR_WORKSPACE_PATH',
  'GHOSTX_ROOT_PATH'
] as const

export function getSetupEnvVars(
  repo: Pick<Repo, 'path'>,
  worktreePath: string
): Record<string, string> {
  return {
    ORCA_ROOT_PATH: repo.path,
    ORCA_WORKTREE_PATH: worktreePath,
    ORCA_WORKSPACE_NAME: getRuntimePathBasename(worktreePath),
    // Imported Conductor scripts read these names.
    CONDUCTOR_ROOT_PATH: repo.path,
    CONDUCTOR_WORKSPACE_PATH: worktreePath,
    CONDUCTOR_WORKSPACE_NAME: getRuntimePathBasename(worktreePath),
    GHOSTX_ROOT_PATH: repo.path
  }
}

export function getSetupRunnerEnvVars(repo: Repo, worktreePath: string): Record<string, string> {
  return {
    ...getSetupEnvVars(repo, worktreePath),
    // Unattended setup always needs credential protection, regardless of user opt-out.
    [TERMINAL_GIT_CREDENTIAL_GUARD_POLICY_ENV]: 'guard'
  }
}
