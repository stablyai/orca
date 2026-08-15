import type { Store } from '../persistence'
import { resolveGitStatusUpstreamRef } from '../git/status-upstream-ref'
import { gitExecFileAsync } from '../git/runner'
import {
  getSshGitProvider,
  getSshGitProviderGeneration,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE
} from '../providers/ssh-git-dispatch'
import { resolveRegisteredWorktreePath } from './filesystem-auth'
import {
  getLocalGitOptionsForRepo,
  getLocalRepoForRegisteredWorktree
} from './local-worktree-runtime-options'
import { setWorktreeGitStatusRefWatch } from './worktree-base-directory-watcher'
import type { GitStatusRefBindingRequest } from './worktree-git-status-ref-watch'

export type GitStatusUpstreamRefWatchRequest = Omit<
  GitStatusRefBindingRequest,
  'providerGeneration'
>

const UPSTREAM_REF_RESOLUTION_TIMEOUT_MS = 15_000

function boundedSignal(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(UPSTREAM_REF_RESOLUTION_TIMEOUT_MS)])
}

export function applyGitStatusUpstreamRefWatchRequest(
  store: Store,
  args: GitStatusUpstreamRefWatchRequest
): Promise<void> {
  const providerGeneration = args.connectionId
    ? getSshGitProviderGeneration(args.connectionId)
    : undefined
  return setWorktreeGitStatusRefWatch(
    { ...args, ...(providerGeneration !== undefined ? { providerGeneration } : {}) },
    async (bindingSignal) => {
      if (!args.branch || !args.upstreamName) {
        return undefined
      }
      const signal = boundedSignal(bindingSignal)
      if (args.connectionId) {
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
        }
        return resolveGitStatusUpstreamRef(
          (gitArgs, cwd, requestSignal) =>
            provider.exec(gitArgs, cwd, {
              signal: requestSignal,
              timeoutMs: UPSTREAM_REF_RESOLUTION_TIMEOUT_MS
            }),
          args.worktreePath,
          args.branch,
          args.upstreamName,
          signal
        )
      }

      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const repo = getLocalRepoForRegisteredWorktree(store, args.worktreePath, worktreePath)
      const gitOptions = getLocalGitOptionsForRepo(store, repo)
      return resolveGitStatusUpstreamRef(
        (gitArgs, cwd, requestSignal) =>
          gitExecFileAsync(gitArgs, {
            cwd,
            signal: requestSignal,
            timeout: UPSTREAM_REF_RESOLUTION_TIMEOUT_MS,
            ...(gitOptions.wslDistro ? { wslDistro: gitOptions.wslDistro } : {})
          }),
        worktreePath,
        args.branch,
        args.upstreamName,
        signal
      )
    }
  )
}
