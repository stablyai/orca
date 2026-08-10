import {
  gitRemoteOperationExecutionTimeoutMs,
  type GitRemoteOperationDeadline
} from '../../shared/git-remote-operation-timeout'

export type GitRuntimeOptions = {
  wslDistro?: string
  signal?: AbortSignal
  remoteOperationDeadline?: GitRemoteOperationDeadline
}

export function gitOptionsForWorktree(
  cwd: string,
  options: GitRuntimeOptions = {}
): {
  cwd: string
  wslDistro?: string
  signal?: AbortSignal
  timeout?: number
  killProcessTree?: true
} {
  return {
    cwd,
    ...(options.wslDistro ? { wslDistro: options.wslDistro } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.remoteOperationDeadline
      ? {
          timeout: gitRemoteOperationExecutionTimeoutMs(options.remoteOperationDeadline),
          killProcessTree: true as const
        }
      : {})
  }
}

export function gitStatusReadOptionsForWorktree(
  cwd: string,
  options: GitRuntimeOptions = {}
): {
  cwd: string
  wslDistro?: string
  signal?: AbortSignal
  preferWslDirectGit: true
} {
  return { ...gitOptionsForWorktree(cwd, options), preferWslDirectGit: true }
}
