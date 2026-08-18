import { getSshGitProviderGeneration } from '../providers/ssh-git-dispatch'
import { runCoalescedProbe, type CoalescedProbes } from './coalesced-probe'
import { isTransientGitProbeError, readRemoteUrl } from './remote-url-probe'
import { isStableMissingGitRemoteError } from './stable-missing-git-remote-error'

/**
 * The "is this repo mine?" probe every forge integration runs: read the remote's
 * URL once per repo/runtime, cache what the provider's parser made of it, and
 * never cache an answer a failed probe never gave.
 */

const REPO_REF_CACHE_MAX_ENTRIES = 512

/**
 * Why: "not this provider" only holds until someone edits the repo's remotes —
 * and a repo first probed before it had any remote answers that way too.
 * Nothing here watches `.git/config`, and a watcher cannot cover the SSH and WSL
 * runtimes this cache also serves, so negatives expire instead: one probe per
 * repo per interval is what lets a remote added mid-session be picked up without
 * a restart. Positives stay, as they did before.
 */
export const NEGATIVE_ENTRY_TTL_MS = 5 * 60_000

type CachedRepoRef<Ref> = { value: Ref | null; expiresAt: number }

export type RemoteRefLocalGitOptions = {
  wslDistro?: string
}

export type RemoteRefProbeCache<Ref> = {
  get(
    repoPath: string,
    remoteName: string,
    connectionId?: string | null,
    localGitOptions?: RemoteRefLocalGitOptions
  ): Promise<Ref | null>
  clear(): void
  size(): number
}

export function createRemoteRefProbeCache<Ref>(
  parseRemoteUrl: (remoteUrl: string) => Ref | null
): RemoteRefProbeCache<Ref> {
  const repoRefCache = new Map<string, CachedRepoRef<Ref>>()
  const inFlight: CoalescedProbes<Ref | null> = new Map()

  function remember(cacheKey: string, value: Ref | null): void {
    repoRefCache.set(cacheKey, {
      value,
      expiresAt: value === null ? Date.now() + NEGATIVE_ENTRY_TTL_MS : Number.POSITIVE_INFINITY
    })
    while (repoRefCache.size > REPO_REF_CACHE_MAX_ENTRIES) {
      const oldestKey = repoRefCache.keys().next().value
      if (oldestKey === undefined) {
        return
      }
      repoRefCache.delete(oldestKey)
    }
  }

  async function probe(
    cacheKey: string,
    ownsKey: () => boolean,
    repoPath: string,
    remoteName: string,
    connectionId: string | null | undefined,
    localGitOptions: RemoteRefLocalGitOptions
  ): Promise<Ref | null> {
    // Why: a probe abandoned as stale still runs, and its answer describes a repo
    // state older than whatever the successor is about to store — or already has.
    // It may still answer its own callers; it may not publish.
    const publish = (value: Ref | null): void => {
      if (ownsKey()) {
        remember(cacheKey, value)
      }
    }
    try {
      const stdout = await readRemoteUrl(
        {
          repoPath,
          connectionId,
          ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {})
        },
        remoteName
      )
      // Why: null is the SSH runtime being disconnected, not an answer about the
      // remote — and it costs no `git`, so there is nothing here to spare. It is
      // deliberately the one negative with no TTL floor: flooring it would make a
      // reconnected host wait the interval out for a probe it could serve now.
      if (stdout === null) {
        return null
      }
      const result = parseRemoteUrl(stdout)
      publish(result)
      return result
    } catch (error) {
      // Why: a probe killed on its deadline says nothing about the remote, and an
      // SSH failure is usually a reconnect or tunnel state rather than an answer.
      // Only "no such remote" is the repo itself saying it is not this provider's
      // — anything else cached would poison it, on SSH for the generation's life.
      if (isTransientGitProbeError(error)) {
        return null
      }
      if (connectionId && !isStableMissingGitRemoteError(error)) {
        return null
      }
      publish(null)
      return null
    }
  }

  return {
    async get(repoPath, remoteName, connectionId, localGitOptions = {}) {
      // Why: a reconnect retires the connection an answer came from, and with it
      // the probe still running on it — stamping the generation stops a caller on
      // the new connection from adopting either.
      const runtimeKey = connectionId
        ? `${connectionId}:${getSshGitProviderGeneration(connectionId)}`
        : `local:${localGitOptions.wslDistro ?? 'host'}`
      const cacheKey = `${runtimeKey}\0${repoPath}\0${remoteName}`
      const cached = repoRefCache.get(cacheKey)
      if (cached) {
        if (cached.expiresAt > Date.now()) {
          return cached.value
        }
        repoRefCache.delete(cacheKey)
      }
      // Why: every branch of a repo resolves its forge through this probe, so a
      // poll of the worktree list arrives as a burst of identical lookups. One
      // young probe answers all of them instead of spawning a `git` per branch.
      return runCoalescedProbe(inFlight, cacheKey, (ownsKey) =>
        probe(cacheKey, ownsKey, repoPath, remoteName, connectionId, localGitOptions)
      )
    },
    clear() {
      repoRefCache.clear()
      inFlight.clear()
    },
    size() {
      return repoRefCache.size
    }
  }
}
