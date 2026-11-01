import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseWslUncPath } from '../../shared/wsl-paths'
import {
  ensureCodexDaemonSocketGuard,
  syncSystemConfigIntoManagedCodexHome
} from '../codex/codex-config-mirror'
import { readCodexTopLevelModelProvider } from '../codex/codex-model-provider-config'
import type { Store } from '../persistence/loading-store/store'
import { toWindowsWslPath } from '../wsl'
import { wasWslDistroLastSeenRunningSettled } from '../wsl-background-distro-gate'
import { WSL_UNC_RUNNING_LEASE_MS } from '../wsl/wsl-unc-access-gate'

export type CanonicalCodexConfig = {
  contents: string
  /** Host-readable source home; the mirror resolves WSL UNC paths to their Linux spelling. */
  sourceHomePath: string
  /** Preserve Linux path semantics when WSL $HOME is under /mnt/<drive>. */
  sourceConfigDir?: string
}

export class CodexConfigMirror {
  constructor(
    private readonly store: Pick<Store, 'getSettings'>,
    private readonly assertManagedHomePath: (
      candidatePath: string,
      expectedAccountId?: string
    ) => string | Promise<string>
  ) {}

  async safeSyncToManagedHomes(): Promise<void> {
    try {
      await this.syncToManagedHomes()
    } catch (error) {
      console.warn('[codex-accounts] Failed to sync canonical config:', error)
    }
  }

  async safeSyncIntoManagedHome(
    managedHomePath: string,
    canonicalConfig?: CanonicalCodexConfig | null,
    expectedAccountId?: string
  ): Promise<void> {
    try {
      await this.syncIntoManagedHome(managedHomePath, canonicalConfig, expectedAccountId)
    } catch (error) {
      console.warn('[codex-accounts] Failed to seed managed config:', error)
    }
  }

  readForManagedHome(managedHomePath: string): CanonicalCodexConfig | null {
    const wslInfo = parseWslUncPath(managedHomePath)
    if (!wslInfo) {
      return this.readHostConfig()
    }

    const managedRootMarker = '/.local/share/orca/codex-accounts/'
    const markerIndex = wslInfo.linuxPath.indexOf(managedRootMarker)
    if (markerIndex === -1) {
      return null
    }
    const wslHome = wslInfo.linuxPath.slice(0, markerIndex)
    const configPath = toWindowsWslPath(`${wslHome}/.codex/config.toml`, wslInfo.distro)
    if (!existsSync(configPath)) {
      return null
    }

    try {
      // Read over UNC while anchoring rewritten paths to the guest-side config directory.
      return {
        contents: readFileSync(configPath, 'utf-8'),
        sourceHomePath: toWindowsWslPath(`${wslHome}/.codex`, wslInfo.distro),
        sourceConfigDir: `${wslHome}/.codex`
      }
    } catch (error) {
      console.warn('[codex-accounts] Failed to read WSL canonical config:', error)
      return null
    }
  }

  assertOAuthAccountAddAllowed(canonicalConfig: CanonicalCodexConfig | null): void {
    const modelProvider = canonicalConfig
      ? readCodexTopLevelModelProvider(canonicalConfig.contents)
      : null
    if (!modelProvider || modelProvider === 'openai') {
      return
    }

    // A custom-provider pin would prevent the new OAuth credentials from being used.
    throw new Error(
      `Orca cannot add a Codex OAuth account while ~/.codex/config.toml pins the custom provider ${JSON.stringify(modelProvider)}. Keep using the system-default account for this provider, or remove model_provider (or set it to "openai") before adding an OAuth account. Orca left your config unchanged.`
    )
  }

  /** Host homes sync before this returns; a WSL home's ownership check finishes later. */
  private async syncToManagedHomes(): Promise<void> {
    const pending: Promise<void>[] = []
    for (const account of this.store.getSettings().codexManagedAccounts) {
      const distro = parseWslUncPath(account.managedHomePath)?.distro
      // Its UNC reads boot a stopped distro (E9); launch preparation syncs that home before use.
      if (
        distro &&
        !wasWslDistroLastSeenRunningSettled(distro, { maxAgeMs: WSL_UNC_RUNNING_LEASE_MS })
      ) {
        continue
      }
      const warn = (error: unknown): void =>
        console.warn('[codex-accounts] Failed to sync managed config:', error)
      try {
        const synced = this.syncIntoManagedHome(account.managedHomePath, undefined, account.id)
        if (synced) {
          pending.push(synced.catch(warn))
        }
      } catch (error) {
        warn(error)
      }
    }
    await Promise.all(pending)
  }

  /** Synchronous for a home whose ownership check is; otherwise the promise of its sync. */
  private syncIntoManagedHome(
    managedHomePath: string,
    canonicalConfig = this.readForManagedHome(managedHomePath),
    expectedAccountId?: string
  ): Promise<void> | undefined {
    if (canonicalConfig === null) {
      // Guard long host homes even without source config; WSL launch preparation guards guest homes.
      if (parseWslUncPath(managedHomePath)) {
        return undefined
      }
      return thenWith(
        this.assertManagedHomePath(managedHomePath, expectedAccountId),
        ensureCodexDaemonSocketGuard
      )
    }
    // Refresh ordinary settings without replacing approvals owned by this runtime home.
    return thenWith(
      this.assertManagedHomePath(managedHomePath, expectedAccountId),
      (runtimeHomePath) =>
        syncSystemConfigIntoManagedCodexHome({
          runtimeHomePath,
          systemHomePath: canonicalConfig.sourceHomePath,
          systemConfigDir: canonicalConfig.sourceConfigDir
        })
    )
  }

  private readHostConfig(): CanonicalCodexConfig | null {
    const sourceHomePath = join(homedir(), '.codex')
    const primaryConfigPath = join(sourceHomePath, 'config.toml')
    if (!existsSync(primaryConfigPath)) {
      return null
    }
    try {
      return { contents: readFileSync(primaryConfigPath, 'utf-8'), sourceHomePath }
    } catch (error) {
      console.warn('[codex-accounts] Failed to read canonical config:', error)
      return null
    }
  }
}

/** Runs `apply` now on a plain value, or once the promise settles. */
function thenWith(
  value: string | Promise<string>,
  apply: (resolved: string) => unknown
): Promise<void> | undefined {
  if (typeof value === 'string') {
    apply(value)
    return undefined
  }
  return value.then((resolved) => {
    apply(resolved)
  })
}
