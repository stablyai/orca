import { getRuntimePathBasename } from '../shared/cross-platform-path'
import { TERMINAL_GIT_CREDENTIAL_GUARD_POLICY_ENV } from '../shared/terminal-git-credential-guard'
import type { Repo } from '../shared/repo-types'

// Why: kept in sync with pty/wsl-orca-env.ts, which path-translates the same keys for WSL.
// ORCA_WORKSPACE_NAME is a display name and the credential-guard policy is an enum — never paths.
export const SETUP_RUNNER_PATH_ENV_KEYS = [
  'ORCA_ROOT_PATH',
  'ORCA_WORKTREE_PATH',
  'CONDUCTOR_ROOT_PATH',
  'GHOSTX_ROOT_PATH'
] as const

export function getSetupEnvVars(repo: Repo, worktreePath: string): Record<string, string> {
  return {
    ORCA_ROOT_PATH: repo.path,
    ORCA_WORKTREE_PATH: worktreePath,
    ORCA_WORKSPACE_NAME: getRuntimePathBasename(worktreePath),
    // Compat with conductor.json users
    CONDUCTOR_ROOT_PATH: repo.path,
    GHOSTX_ROOT_PATH: repo.path
  }
}

export function getSetupRunnerEnvVars(repo: Repo, worktreePath: string): Record<string, string> {
  return {
    ...getSetupEnvVars(repo, worktreePath),
    // Why: the Setup terminal is unattended automation, so force the credential guard regardless of user opt-out.
    [TERMINAL_GIT_CREDENTIAL_GUARD_POLICY_ENV]: 'guard'
  }
}
