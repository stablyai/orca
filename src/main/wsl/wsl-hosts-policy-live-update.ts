import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { readFetchResponseTextWithinLimit } from '../../shared/fetch-response-body'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'
import { getVersionChannel, MAIN_RELEASE_REPO } from '../../shared/release-channel'
import { isWslHostsInternalGateOpen } from '../../shared/wsl-host-internal-gate'
import {
  parseWslHostsPolicy,
  WSL_HOSTS_POLICY_MAX_BYTES,
  type WslHostsPolicy
} from '../../shared/wsl-hosts-policy'
import { getMainHttpClient } from '../network/http-client'
import { writePluginFileAtomically } from '../plugins/installation/plugin-atomic-file-write'

const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 30_000

export type WslHostsPolicyChannel = 'next' | 'stable'

export function wslHostsPolicyChannelForAppVersion(
  appVersion: string
): WslHostsPolicyChannel | null {
  const channel = getVersionChannel(appVersion)
  if (!channel) {
    return null
  }
  return channel === 'stable' ? 'stable' : 'next'
}

// A fixed release-asset URL: no API rate limit, and stable can be switched apart from prereleases.
export function wslHostsPolicyDownloadUrl(channel: WslHostsPolicyChannel): string {
  return `https://github.com/${MAIN_RELEASE_REPO}/releases/download/wsl-hosts-policy-${channel}/wsl-hosts-policy.json`
}

// Shared userData must not apply a prerelease-only switch to stable builds.
export function wslHostsPolicyCacheFileName(channel: WslHostsPolicyChannel): string {
  return `wsl-hosts-policy-${channel}.json`
}

function warn(message: string): void {
  console.warn(`[wsl-hosts-policy] ${message}`)
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

/** The last policy a download cached, read synchronously so the startup gate can use it. */
export function readCachedWslHostsPolicy(
  userDataPath: string,
  appVersion: string
): WslHostsPolicy | null {
  const channel = wslHostsPolicyChannelForAppVersion(appVersion)
  if (!channel) {
    return null
  }
  try {
    const { buffer } = readNodeFileSyncWithinLimit(
      join(userDataPath, wslHostsPolicyCacheFileName(channel)),
      WSL_HOSTS_POLICY_MAX_BYTES,
      { regularFileOnly: true }
    )
    const parsed = parseWslHostsPolicy(buffer.toString('utf8'))
    if (!parsed.ok) {
      warn(`cached policy ignored: ${parsed.error}`)
      return null
    }
    return parsed.policy
  } catch (error) {
    if (!isMissingFile(error)) {
      warn(`cached policy unreadable: ${describeError(error)}`)
    }
    return null
  }
}

export type WslHostsPolicyLiveUpdateDeps = {
  userDataPath: string
  appVersion: string
  /** Unpackaged dev and test runs never download. */
  isPackaged: boolean
  fetch: (url: string, init?: RequestInit) => Promise<Response>
}

/**
 * Keeps the cached policy current; it applies on the next launch, never mid-run, so a flip cannot
 * pull a running host or an in-flight move out from under the user. Failures keep the cache.
 */
export class WslHostsPolicyLiveUpdater {
  private channel: WslHostsPolicyChannel | null = null
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: WslHostsPolicyLiveUpdateDeps) {}

  async start(): Promise<void> {
    this.stop()
    if (!this.deps.isPackaged) {
      return
    }
    this.channel = wslHostsPolicyChannelForAppVersion(this.deps.appVersion)
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

  async refresh(): Promise<void> {
    const channel = this.channel
    if (!channel) {
      return
    }
    const text = await this.fetchText(channel)
    if (this.channel !== channel || text === null) {
      return
    }
    const parsed = parseWslHostsPolicy(text)
    if (!parsed.ok) {
      warn(`download rejected: ${parsed.error}`)
      return
    }
    const cached = readCachedWslHostsPolicy(this.deps.userDataPath, this.deps.appVersion)
    // A stale mirror or replayed file must never undo a newer switch.
    if (cached && parsed.policy.revision <= cached.revision) {
      return
    }
    try {
      // The validated text, not the parsed object: parsing strips fields this build doesn't know,
      // and an equal revision never rewrites the cache, so a newer build would never see them.
      await writePluginFileAtomically(
        join(this.deps.userDataPath, wslHostsPolicyCacheFileName(channel)),
        text
      )
    } catch (error) {
      warn(`downloaded policy not cached: ${describeError(error)}`)
    }
  }

  private async fetchText(channel: WslHostsPolicyChannel): Promise<string | null> {
    try {
      const response = await this.deps.fetch(wslHostsPolicyDownloadUrl(channel), {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        // Unpublished (404) is the normal state: nothing is switched off.
        if (response.status !== 404) {
          warn(`download failed: HTTP ${response.status}`)
        }
        return null
      }
      return await readFetchResponseTextWithinLimit(response, WSL_HOSTS_POLICY_MAX_BYTES)
    } catch (error) {
      warn(`download failed: ${describeError(error)}`)
      return null
    }
  }
}

/** Fetches only where the launch environment opened the gate, even while a cached block closes it. */
export function startWslHostsPolicyLiveUpdates(): void {
  if (process.platform !== 'win32' || !isWslHostsInternalGateOpen(process.env)) {
    return
  }
  const environment = getAppEnvironment()
  const updater = new WslHostsPolicyLiveUpdater({
    userDataPath: environment.getPath('userData'),
    appVersion: environment.getVersion(),
    isPackaged: environment.isPackaged(),
    fetch: (url, init) => getMainHttpClient().fetch(url, init)
  })
  void updater.start()
  environment.onWillQuit(() => updater.stop())
}
