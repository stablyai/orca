import { getRuntimePathBasename } from '../shared/cross-platform-path'
import { TERMINAL_GIT_CREDENTIAL_GUARD_POLICY_ENV } from '../shared/terminal-git-credential-guard'
import type { Repo } from '../shared/repo-types'

// Keep WSL path translation in pty/wsl-orca-env.ts in sync; names and policies are not paths.
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
    // Legacy conductor.json compatibility.
    CONDUCTOR_ROOT_PATH: repo.path,
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
