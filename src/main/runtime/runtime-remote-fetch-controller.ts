import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import type { GitExecOptions } from '../git/command-runner/git-exec-options'
import type { LocalGitExecOptions } from '../git/repo-default-base-ref'
import { GIT_FETCH_SKIP_AUTO_MAINTENANCE_CONFIG_ARGS } from '../../shared/git-fetch-auto-maintenance'
import { getCanonicalRepoKey, type CanonicalRepoKeyOptions } from '../git/canonical-repo-key'
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

type GitOptions = LocalGitExecOptions

// Why: reuse recent fetches across create and drift probes without hiding remote changes for long.
const FETCH_FRESHNESS_MS = 30_000
// Why: a credential-manager prompt must not wedge worktree creation indefinitely.
const REMOTE_FETCH_TIMEOUT_MS = 60_000
const PREVIEW_FETCH_BUDGET_MS = 10_000
const REMOTE_FETCH_CACHE_MAX = 512

export class RuntimeRemoteFetchController {
  private readonly fetchInflight = new Map<string, Promise<RemoteFetchResult>>()
  private readonly remoteFetchQueueTail = new Map<string, Promise<RemoteFetchResult>>()
  private readonly fetchLastCompletedAt = new Map<string, number>()
  private readonly canonicalFetchKeyCache = new Map<string, string>()

  /** `${runtimeKey}::${gitCommonDir}` -- one repo on one execution host. */
  async getCanonicalRepoKey(
    repoPath: string,
    gitOptions: CanonicalRepoKeyOptions = {}
  ): Promise<string> {
    return getCanonicalRepoKey(repoPath, gitOptions)
  }

  async getCanonicalFetchKey(
    repoPath: string,
    remote: string,
    gitOptions: CanonicalRepoKeyOptions = {}
  ): Promise<string> {
    const runtimeKey = gitOptions.wslDistro ? `wsl:${gitOptions.wslDistro}` : 'local'
    const cacheKey = `${runtimeKey}::${repoPath}::${remote}`
    const cached = this.canonicalFetchKeyCache.get(cacheKey)
    const resolved = cached ?? `${await this.getCanonicalRepoKey(repoPath, gitOptions)}::${remote}`
    setBoundedMapEntry(this.canonicalFetchKeyCache, cacheKey, resolved, REMOTE_FETCH_CACHE_MAX)
    return resolved
  }

  /** Exact-base fetch skips auto-maintenance and leaves loose refs; arm repo maintenance after quiet time, extended by each fetch. */
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
    return [...this.remoteFetchQueueTail.keys()].some((key) => key.startsWith(`${repoKey}::`))
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
      return this.runExactBaseRefresh(repoPath, base, key, gitOptions)
    }).finally(() => {
      this.fetchInflight.delete(key)
      this.armRefMaintenance(repoPath, gitOptions)
    })
    this.fetchInflight.set(key, promise)
    return promise
  }

  async refreshRemoteTrackingBaseForPreview(
    repoPath: string,
    base: RemoteTrackingBase,
    gitOptions: GitOptions = {}
  ): Promise<RemoteFetchResult> {
    const expiresAt = Date.now() + PREVIEW_FETCH_BUDGET_MS
    const expiry = new AbortController()
    const canStart = (): boolean => !expiry.signal.aborted && Date.now() < expiresAt
    const previewOptions = { ...gitOptions, signal: expiry.signal, canStart }
    const timer = setTimeout(() => expiry.abort(), PREVIEW_FETCH_BUDGET_MS)
    const operation = (async (): Promise<RemoteFetchResult> => {
      const remoteKey = await this.getCanonicalFetchKey(repoPath, base.remote, previewOptions)
      const key = await this.getCanonicalFetchKey(
        repoPath,
        `base:${base.remote}:${base.branch}`,
        previewOptions
      )
      if (!canStart()) {
        return { ok: false, errorKind: 'git_error' }
      }
      if (this.getFreshFetchCompletedAt(key) !== null) {
        return { ok: true }
      }
      const normal = this.fetchInflight.get(key)
      if (normal) {
        return normal
      }
      // Preview lifetime/failure is private; normal callers reuse only its successful freshness.
      return this.enqueueRemoteFetch(remoteKey, () => {
        const remainingMs = expiresAt - Date.now()
        if (!canStart() || remainingMs <= 0) {
          return Promise.resolve<RemoteFetchResult>({ ok: false, errorKind: 'git_error' })
        }
        if (this.getFreshFetchCompletedAt(key) !== null) {
          return Promise.resolve<RemoteFetchResult>({ ok: true })
        }
        return this.runExactBaseRefresh(repoPath, base, key, previewOptions, remainingMs)
      }).finally(() => this.armRefMaintenance(repoPath, gitOptions))
    })()
    try {
      return await waitForPromiseWithSignal(operation, expiry.signal)
    } catch {
      return { ok: false, errorKind: 'git_error' }
    } finally {
      clearTimeout(timer)
    }
  }

  private runExactBaseRefresh(
    repoPath: string,
    base: RemoteTrackingBase,
    key: string,
    gitOptions: GitOptions & Pick<GitExecOptions, 'signal' | 'canStart'>,
    timeout = REMOTE_FETCH_TIMEOUT_MS
  ): Promise<RemoteFetchResult> {
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
        timeout
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
    const remoteRefPrefix = 'refs/remotes/'
    if (baseBranch.startsWith('refs/') && !baseBranch.startsWith(remoteRefPrefix)) {
      return null
    }
    const shortBaseBranch = baseBranch.startsWith(remoteRefPrefix)
      ? baseBranch.slice(remoteRefPrefix.length)
      : baseBranch
    // A remote-tracking base needs both a configured remote and a branch component.
    if (shortBaseBranch.indexOf('/') <= 0 || shortBaseBranch.endsWith('/')) {
      return null
    }
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
