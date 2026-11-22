import { join } from 'node:path'
import { readFetchResponseTextWithinLimit } from '../../shared/network/fetch-response-body'
import {
  readNodeFileSyncWithinLimit,
  readNodeFileWithinLimit
} from '../../shared/file-content/node-bounded-file-reader'
import { getVersionChannel, MAIN_RELEASE_REPO } from '../../shared/updater/release-channel'
import { writePluginFileAtomically } from '../plugins/installation/plugin-atomic-file-write'

const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 30_000

export type ReleaseAssetPolicyChannel = 'next' | 'stable'

export type ReleaseAssetPolicyParse<P> = { ok: true; policy: P } | { ok: false; error: string }

/** A JSON policy published as a GitHub release asset, one release per channel. */
export type ReleaseAssetPolicySpec<P extends { revision: number }> = {
  /** Log prefix and file stem, e.g. `wsl-hosts-policy`. */
  name: string
  /** The release tag holding the asset, e.g. `wsl-hosts-policy-stable`. */
  releaseTag: (channel: ReleaseAssetPolicyChannel) => string
  assetName: string
  maxBytes: number
  parse: (text: string) => ReleaseAssetPolicyParse<P>
}

export function releaseAssetPolicyChannelForAppVersion(
  appVersion: string
): ReleaseAssetPolicyChannel | null {
  const channel = getVersionChannel(appVersion)
  if (!channel) {
    return null
  }
  return channel === 'stable' ? 'stable' : 'next'
}

// A fixed release-asset URL: no API rate limit, and stable can be switched apart from prereleases.
export function releaseAssetPolicyDownloadUrl<P extends { revision: number }>(
  spec: ReleaseAssetPolicySpec<P>,
  channel: ReleaseAssetPolicyChannel
): string {
  return `https://github.com/${MAIN_RELEASE_REPO}/releases/download/${spec.releaseTag(channel)}/${spec.assetName}`
}

// Shared userData must not apply a prerelease-only switch to stable builds.
export function releaseAssetPolicyCacheFileName<P extends { revision: number }>(
  spec: ReleaseAssetPolicySpec<P>,
  channel: ReleaseAssetPolicyChannel
): string {
  return `${spec.name}-${channel}.json`
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

/** The last policy a download cached, read synchronously so a startup gate can use it. */
export function readCachedReleaseAssetPolicy<P extends { revision: number }>(
  spec: ReleaseAssetPolicySpec<P>,
  userDataPath: string,
  appVersion: string
): P | null {
  const channel = releaseAssetPolicyChannelForAppVersion(appVersion)
  if (!channel) {
    return null
  }
  try {
    const { buffer } = readNodeFileSyncWithinLimit(
      join(userDataPath, releaseAssetPolicyCacheFileName(spec, channel)),
      spec.maxBytes,
      { regularFileOnly: true }
    )
    const parsed = spec.parse(buffer.toString('utf8'))
    if (!parsed.ok) {
      console.warn(`[${spec.name}] cached policy ignored: ${parsed.error}`)
      return null
    }
    return parsed.policy
  } catch (error) {
    if (!isMissingFile(error)) {
      console.warn(`[${spec.name}] cached policy unreadable: ${describeError(error)}`)
    }
    return null
  }
}

/** The same, read without blocking, for work that runs off the startup path. */
export async function readCachedReleaseAssetPolicyAsync<P extends { revision: number }>(
  spec: ReleaseAssetPolicySpec<P>,
  userDataPath: string,
  appVersion: string
): Promise<P | null> {
  const channel = releaseAssetPolicyChannelForAppVersion(appVersion)
  if (!channel) {
    return null
  }
  try {
    const { buffer } = await readNodeFileWithinLimit(
      join(userDataPath, releaseAssetPolicyCacheFileName(spec, channel)),
      spec.maxBytes,
      { regularFileOnly: true }
    )
    const parsed = spec.parse(buffer.toString('utf8'))
    return parsed.ok ? parsed.policy : null
  } catch {
    return null
  }
}

function newerPolicy<P extends { revision: number }>(left: P | null, right: P | null): P | null {
  return left && (!right || left.revision >= right.revision) ? left : right
}

export type ReleaseAssetPolicyLiveUpdateDeps<P> = {
  userDataPath: string
  appVersion: string
  /** Unpackaged dev and test runs never download. */
  isPackaged: boolean
  fetch: (url: string, init?: RequestInit) => Promise<Response>
  /** Each successful download, with the policy now in force: the newer of it and the cache. */
  onFetched?: (policy: P) => void
}

/**
 * Keeps a release-asset policy's cache current. Failures keep the cache; a revision no newer than
 * the cached one never replaces it, so a stale mirror or replayed file can't undo a newer switch.
 */
export class ReleaseAssetPolicyLiveUpdater<P extends { revision: number }> {
  private channel: ReleaseAssetPolicyChannel | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private fetched: { policy: P; downloaded: P; at: number } | null = null
  // The newest policy this process has known, so a cache write that failed can't let an older
  // download win later.
  private newest: P | null = null
  // The downloaded text of `newest`, so a retried cache write saves the policy in force.
  private newestText: string | null = null
  // One refresh at a time, so the cache is never published out of order.
  private refreshing: Promise<void> = Promise.resolve()

  constructor(
    private readonly spec: ReleaseAssetPolicySpec<P>,
    private readonly deps: ReleaseAssetPolicyLiveUpdateDeps<P>
  ) {}

  async start(): Promise<void> {
    this.stop()
    if (!this.deps.isPackaged) {
      return
    }
    this.channel = releaseAssetPolicyChannelForAppVersion(this.deps.appVersion)
    if (!this.channel) {
      return
    }
    this.timer = setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS)
    this.timer.unref?.()
    await this.refresh()
  }

  stop(): void {
    this.channel = null
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * The policy in force when the last download succeeded, what that download itself held (older
   * than `policy` when the cache won), and when; null after a failed one.
   */
  lastFetched(): { policy: P; downloaded: P; at: number } | null {
    return this.fetched
  }

  /** The newest policy known, downloaded this run or cached, even after a failed download. */
  async newestKnown(): Promise<P | null> {
    return newerPolicy(
      await readCachedReleaseAssetPolicyAsync(
        this.spec,
        this.deps.userDataPath,
        this.deps.appVersion
      ),
      this.newest
    )
  }

  /** Waits for any refresh already running, then downloads again. */
  refresh(): Promise<void> {
    const run = this.refreshing.then(() => this.refreshNow())
    this.refreshing = run.catch(() => {})
    return run
  }

  private async refreshNow(): Promise<void> {
    const channel = this.channel
    if (!channel) {
      return
    }
    const text = await this.fetchText(channel)
    if (this.channel !== channel) {
      return
    }
    const parsed = text === null ? null : this.spec.parse(text)
    if (text === null || !parsed?.ok) {
      if (parsed && !parsed.ok) {
        this.warn(`download rejected: ${parsed.error}`)
      }
      this.fetched = null
      return
    }
    const cached = readCachedReleaseAssetPolicy(
      this.spec,
      this.deps.userDataPath,
      this.deps.appVersion
    )
    const known = newerPolicy(cached, this.newest)
    const stale = known !== null && parsed.policy.revision <= known.revision
    const policy = stale ? known : parsed.policy
    if (policy !== this.newest) {
      this.newestText = policy === parsed.policy ? text : null
    }
    this.newest = policy
    this.fetched = { policy, downloaded: parsed.policy, at: Date.now() }
    // Before the write, so the policy applies this run even if caching it fails.
    this.deps.onFetched?.(policy)
    // Against the file, not memory: a write that failed earlier is retried by the next download,
    // always with the text of the policy in force, never a same-revision download's.
    const policyText = policy === parsed.policy ? text : this.newestText
    if (policyText === null || (cached !== null && policy.revision <= cached.revision)) {
      return
    }
    try {
      // The validated text, not the parsed object: parsing strips fields this build doesn't know,
      // and an equal revision never rewrites the cache, so a newer build would never see them.
      await writePluginFileAtomically(
        join(this.deps.userDataPath, releaseAssetPolicyCacheFileName(this.spec, channel)),
        policyText
      )
    } catch (error) {
      this.warn(`downloaded policy not cached: ${describeError(error)}`)
    }
  }

  private warn(message: string): void {
    console.warn(`[${this.spec.name}] ${message}`)
  }

  private async fetchText(channel: ReleaseAssetPolicyChannel): Promise<string | null> {
    try {
      const response = await this.deps.fetch(releaseAssetPolicyDownloadUrl(this.spec, channel), {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        // Unpublished (404) is the normal state.
        if (response.status !== 404) {
          this.warn(`download failed: HTTP ${response.status}`)
        }
        return null
      }
      return await readFetchResponseTextWithinLimit(response, this.spec.maxBytes)
    } catch (error) {
      this.warn(`download failed: ${describeError(error)}`)
      return null
    }
  }
}
