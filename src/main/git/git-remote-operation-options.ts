import {
  gitRemoteOperationExecutionTimeoutMs,
  resolveGitRemoteOperationTimeoutMs,
  runWithGitRemoteOperationDeadline
} from '../../shared/git-remote-operation-timeout'
import type { GitRuntimeOptions } from './git-runtime-options'
import { gitOptionsForWorktree } from './git-runtime-options'

export function gitRemoteOperationOptionsForWorktree(
  worktreePath: string,
  options: GitRuntimeOptions = {}
): ReturnType<typeof gitOptionsForWorktree> & {
  timeout: number
  killProcessTree: true
  useConfiguredSshCommandForNetwork: true
} {
  const deadline = options.remoteOperationDeadline
  if (!deadline) {
    throw new Error('Missing remote Git operation deadline.')
  }
  return {
    ...gitOptionsForWorktree(worktreePath, options),
    // Why: credential helpers, hooks, and remote transports can stall without
    // returning control to Source Control; bound and clean up the whole tree.
    timeout: gitRemoteOperationExecutionTimeoutMs(deadline),
    killProcessTree: true,
    useConfiguredSshCommandForNetwork: true
  }
}

export function runLocalGitRemoteOperation<T>(
  options: GitRuntimeOptions,
  run: (options: GitRuntimeOptions) => Promise<T>
): Promise<T> {
  if (options.remoteOperationDeadline) {
    return run(options)
  }
  return runWithGitRemoteOperationDeadline(
    resolveGitRemoteOperationTimeoutMs(process.env.ORCA_GIT_REMOTE_OPERATION_TIMEOUT_MS),
    ({ deadline, signal }) => run({ ...options, signal, remoteOperationDeadline: deadline }),
    options.signal
  )
}
