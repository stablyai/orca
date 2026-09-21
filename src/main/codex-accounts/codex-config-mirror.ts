import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { syncSystemConfigIntoManagedCodexHome } from '../codex/codex-config-mirror'
import { readCodexTopLevelModelProvider } from '../codex/codex-model-provider-config'
import type { Store } from '../persistence'
import { toWindowsWslPath } from '../wsl'

export type CanonicalCodexConfig = {
  contents: string
  /** Host-readable source home; the mirror resolves WSL UNC paths to their Linux spelling. */
  sourceHomePath: string
  /** Preserve Linux path semantics when WSL $HOME is under /mnt/<drive>. */
  sourceConfigDir?: string
}

export class CodexConfigMirror {
  constructor(
    private readonly store: Store,
    private readonly assertManagedHomePath: (
      candidatePath: string,
      expectedAccountId?: string
    ) => string
  ) {}

  safeSyncToManagedHomes(): void {
    try {
      this.syncToManagedHomes()
    } catch (error) {
      console.warn('[codex-accounts] Failed to sync canonical config:', error)
    }
  }

  safeSyncIntoManagedHome(
    managedHomePath: string,
    canonicalConfig?: CanonicalCodexConfig | null,
    expectedAccountId?: string
  ): void {
    try {
      this.syncIntoManagedHome(managedHomePath, canonicalConfig, expectedAccountId)
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
      // Why: the config is read over UNC but consumed by Codex inside WSL, so
      // path rewrites must anchor to the Linux-side ~/.codex, not the UNC path.
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

    // Why: mirroring a custom-provider pin into an OAuth managed home makes
    // the new OAuth credentials inert; fail before login and leave user config intact.
    throw new Error(
      `Orca cannot add a Codex OAuth account while ~/.codex/config.toml pins the custom provider ${JSON.stringify(modelProvider)}. Keep using the system-default account for this provider, or remove model_provider (or set it to "openai") before adding an OAuth account. Orca left your config unchanged.`
    )
  }

  private syncToManagedHomes(): void {
    for (const account of this.store.getSettings().codexManagedAccounts) {
      try {
        this.syncIntoManagedHome(account.managedHomePath, undefined, account.id)
      } catch (error) {
        console.warn('[codex-accounts] Failed to sync managed config:', error)
      }
    }
  }

  private syncIntoManagedHome(
    managedHomePath: string,
    canonicalConfig = this.readForManagedHome(managedHomePath),
    expectedAccountId?: string
  ): void {
    if (canonicalConfig === null) {
      return
    }
    const trustedManagedHomePath = this.assertManagedHomePath(managedHomePath, expectedAccountId)
    // Why: every account home is Codex's own CODEX_HOME. Preserve trust Codex
    // granted there while refreshing ordinary settings from the lane's source.
    syncSystemConfigIntoManagedCodexHome({
      runtimeHomePath: trustedManagedHomePath,
      systemHomePath: canonicalConfig.sourceHomePath,
      systemConfigDir: canonicalConfig.sourceConfigDir
    })
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
