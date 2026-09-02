import { GIT_FETCH_SKIP_AUTO_MAINTENANCE_CONFIG_ARGS } from '../../shared/git-fetch-auto-maintenance'
import { getCanonicalRepoKey } from '../git/canonical-repo-key'
import {
  armLocalRepoRefMaintenance,
  setRepoRefMaintenanceBusyProbe
} from '../git/local-repo-ref-maintenance'
import { gitExecFileAsync } from '../git/runner'
import { setBoundedMapEntry } from './runtime-async-boundaries'

export type RemoteFetchResult = { ok: true } | { ok: false; errorKind: 'git_error' }

export type RemoteTrackingBase = {
  remote: string
  branch: string
  ref: string
  base: string
}

type GitOptions = { wslDistro?: string }

// Why: reuse recent fetches across create and drift probes without hiding remote changes for long.
const FETCH_FRESHNESS_MS = 30_000
// Why: a credential-manager prompt must not wedge worktree creation indefinitely.
const REMOTE_FETCH_TIMEOUT_MS = 60_000
const REMOTE_FETCH_CACHE_MAX = 512

export class RuntimeRemoteFetchController {
  private readonly fetchInflight = new Map<string, Promise<RemoteFetchResult>>()
  private readonly remoteFetchQueueTail = new Map<string, Promise<RemoteFetchResult>>()
  private readonly fetchLastCompletedAt = new Map<string, number>()
  private readonly canonicalFetchKeyCache = new Map<string, string>()

  getCanonicalFetchKeyCache(): ReadonlyMap<string, string> {
    return this.canonicalFetchKeyCache
  }

  getFetchLastCompletedAt(): ReadonlyMap<string, number> {
    return this.fetchLastCompletedAt
  }

  /** `${runtimeKey}::${gitCommonDir}` -- one repo on one execution host. */
  async getCanonicalRepoKey(repoPath: string, gitOptions: GitOptions = {}): Promise<string> {
    return getCanonicalRepoKey(repoPath, gitOptions)
  }

  async getCanonicalFetchKey(
    repoPath: string,
    remote: string,
    gitOptions: GitOptions = {}
  ): Promise<string> {
    const runtimeKey = gitOptions.wslDistro ? `wsl:${gitOptions.wslDistro}` : 'local'
    const cacheKey = `${runtimeKey}::${repoPath}::${remote}`
    const cached = this.canonicalFetchKeyCache.get(cacheKey)
    if (cached !== undefined) {
      setBoundedMapEntry(this.canonicalFetchKeyCache, cacheKey, cached, REMOTE_FETCH_CACHE_MAX)
      return cached
    }
    const resolved = `${await this.getCanonicalRepoKey(repoPath, gitOptions)}::${remote}`
    setBoundedMapEntry(this.canonicalFetchKeyCache, cacheKey, resolved, REMOTE_FETCH_CACHE_MAX)
    return resolved
  }

  /**
   * Orca strips git's auto-maintenance off these fetches, so every one of them
   * adds to a loose-ref backlog nothing else will ever pack. Arm the idle sweep
   * that pays it back; each fetch pushes the attempt a further quiet period out.
   */
  private armRefMaintenance(repoPath: string, gitOptions: GitOptions): void {
    void this.getCanonicalRepoKey(repoPath, gitOptions)
      .then((key) => {
        setRepoRefMaintenanceBusyProbe(key, () => this.hasInflightFetchForRepo(key))
        armLocalRepoRefMaintenance({
          key,
          repoPath,
          ...(gitOptions.wslDistro ? { wslDistro: gitOptions.wslDistro } : {})
        })
      })
      .catch(() => {
        // Maintenance is best effort; a repo we cannot name is a repo we skip.
      })
  }

  private hasInflightFetchForRepo(repoKey: string): boolean {
    const prefix = `${repoKey}::`
    for (const key of this.fetchInflight.keys()) {
      if (key.startsWith(prefix)) {
        return true
      }
    }
    return false
  }

  private enqueueRemoteFetch(
    remoteKey: string,
    runFetch: () => Promise<RemoteFetchResult>
  ): Promise<RemoteFetchResult> {
    const previous = this.remoteFetchQueueTail.get(remoteKey)
    const promise = previous ? previous.then(runFetch, runFetch) : runFetch()
    this.remoteFetchQueueTail.set(remoteKey, promise)
    promise.finally(() => {
      if (this.remoteFetchQueueTail.get(remoteKey) === promise) {
        this.remoteFetchQueueTail.delete(remoteKey)
      }
    })
    return promise
  }

  private getFreshFetchCompletedAt(key: string): number | null {
    const lastAt = this.fetchLastCompletedAt.get(key)
    if (lastAt === undefined) {
      return null
    }
    if (Date.now() - lastAt < FETCH_FRESHNESS_MS) {
      setBoundedMapEntry(this.fetchLastCompletedAt, key, lastAt, REMOTE_FETCH_CACHE_MAX)
      return lastAt
    }
    this.fetchLastCompletedAt.delete(key)
    return null
  }

  private rememberFreshFetchCompletedAt(key: string, completedAt = Date.now()): void {
    setBoundedMapEntry(this.fetchLastCompletedAt, key, completedAt, REMOTE_FETCH_CACHE_MAX)
  }

  async getOrStartRemoteFetch(
    repoPath: string,
    remote: string,
    gitOptions: GitOptions = {}
  ): Promise<RemoteFetchResult> {
    const key = await this.getCanonicalFetchKey(repoPath, remote, gitOptions)
    if (this.getFreshFetchCompletedAt(key) !== null) {
      return { ok: true }
    }
    const existing = this.fetchInflight.get(key)
    if (existing) {
      return existing
    }
    const promise = this.enqueueRemoteFetch(key, () =>
      gitExecFileAsync(['fetch', remote], {
        cwd: repoPath,
        ...gitOptions,
        timeout: REMOTE_FETCH_TIMEOUT_MS
      })
        .then((): RemoteFetchResult => {
          this.rememberFreshFetchCompletedAt(key)
          return { ok: true }
        })
        .catch((err): RemoteFetchResult => {
          console.warn(`[fetchRemoteWithCache] ${remote} fetch failed for ${repoPath}:`, err)
          return { ok: false, errorKind: 'git_error' }
        })
    ).finally(() => {
      this.fetchInflight.delete(key)
      this.armRefMaintenance(repoPath, gitOptions)
    })
    this.fetchInflight.set(key, promise)
    return promise
  }

  async getOrStartRemoteTrackingBaseRefresh(
    repoPath: string,
    base: RemoteTrackingBase,
    gitOptions: GitOptions = {}
  ): Promise<RemoteFetchResult> {
    const remoteKey = await this.getCanonicalFetchKey(repoPath, base.remote, gitOptions)
    const key = await this.getCanonicalFetchKey(
      repoPath,
      `base:${base.remote}:${base.branch}`,
      gitOptions
    )
    if (this.getFreshFetchCompletedAt(key) !== null) {
      return { ok: true }
    }
    const existing = this.fetchInflight.get(key)
    if (existing) {
      return existing
    }
    const promise = this.enqueueRemoteFetch(remoteKey, async () => {
      if (this.getFreshFetchCompletedAt(key) !== null) {
        return { ok: true }
      }
      return gitExecFileAsync(
        [
          ...GIT_FETCH_SKIP_AUTO_MAINTENANCE_CONFIG_ARGS,
          'fetch',
          '--no-tags',
          base.remote,
          `+refs/heads/${base.branch}:${base.ref}`
        ],
        {
          cwd: repoPath,
          ...gitOptions,
          useConfiguredSshCommandForNetwork: true,
          timeout: REMOTE_FETCH_TIMEOUT_MS
        }
      )
        .then((): RemoteFetchResult => {
          this.rememberFreshFetchCompletedAt(key)
          return { ok: true }
        })
        .catch((err): RemoteFetchResult => {
          console.warn(
            `[refreshRemoteTrackingBase] ${base.base} refresh failed for ${repoPath}:`,
            err
          )
          return { ok: false, errorKind: 'git_error' }
        })
    }).finally(() => {
      this.fetchInflight.delete(key)
      this.armRefMaintenance(repoPath, gitOptions)
    })
    this.fetchInflight.set(key, promise)
    return promise
  }

  async fetchRemoteWithCache(
    repoPath: string,
    remote: string,
    gitOptions: GitOptions = {}
  ): Promise<void> {
    await this.getOrStartRemoteFetch(repoPath, remote, gitOptions)
  }

  async resolveRemoteTrackingBase(
    repoPath: string,
    baseBranch: string,
    gitOptions: GitOptions = {}
  ): Promise<RemoteTrackingBase | null> {
    let remotes: string[]
    try {
      const { stdout } = await gitExecFileAsync(['remote'], { cwd: repoPath, ...gitOptions })
      remotes = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    } catch {
      return null
    }
    const remoteRefPrefix = 'refs/remotes/'
    const shortBaseBranch = baseBranch.startsWith(remoteRefPrefix)
      ? baseBranch.slice(remoteRefPrefix.length)
      : baseBranch
    const remote = remotes
      .filter((candidate) => shortBaseBranch.startsWith(`${candidate}/`))
      .sort((a, b) => b.length - a.length)[0]
    if (!remote) {
      return null
    }
    const branch = shortBaseBranch.slice(remote.length + 1)
    if (!branch) {
      return null
    }
    return {
      remote,
      branch,
      ref: `refs/remotes/${remote}/${branch}`,
      base: `${remote}/${branch}`
    }
  }

  async hasRemoteTrackingRef(
    repoPath: string,
    base: RemoteTrackingBase,
    gitOptions: GitOptions = {}
  ): Promise<boolean> {
    try {
      await gitExecFileAsync(['rev-parse', '--verify', `${base.ref}^{commit}`], {
        cwd: repoPath,
        ...gitOptions
      })
      return true
    } catch {
      return false
    }
  }
}
