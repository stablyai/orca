import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isDefinitiveAbsence } from '../../../shared/errors/definitive-filesystem-absence'
import { createIntegrationStateFileCache } from '../../credentials/integration-state-file-cache'
import {
  parseWslUncPath,
  toLinuxPath,
  toWindowsWslPath
} from '../../../shared/file-access/wsl-paths'
import {
  ensureCodexDaemonSocketGuard,
  syncSystemConfigIntoManagedCodexHome
} from '../../codex/configuration/settings/codex-config-mirror'
import { readCodexTopLevelModelProvider } from '../../codex/structured/launch/codex-model-provider-config'
import type { Store } from '../../persistence/loading-store/store'
import type { CodexManagedAccount } from '../../../shared/agent-accounts/managed-account-types'
import { wasWslDistroLastSeenRunningSettled } from '../../wsl/discovery/wsl-background-distro-gate'
import { WSL_UNC_RUNNING_LEASE_MS } from '../../wsl/filesystem/wsl-unc-access-gate'
import { syncWslCodexConfigInDistro } from '../../codex/configuration/settings/wsl-codex-config-sync'

const WSL_MANAGED_ROOT_MARKER = '/.local/share/orca/codex-accounts/'

export type CanonicalCodexConfig = {
  contents: string
  sourceHomePath: string
}

export class CodexConfigMirror {
  private readonly hostModelProvider = createIntegrationStateFileCache({
    filePath: () => join(homedir(), '.codex', 'config.toml'),
    readFromDisk: () => {
      try {
        return readCodexTopLevelModelProvider(
          this.readHostConfigContents(join(homedir(), '.codex', 'config.toml'))
        )
      } catch (error) {
        if (!isDefinitiveAbsence(error)) {
          throw error
        }
        return null
      }
    }
  })

  async readHostModelProvider(): Promise<string | null> {
    try {
      return await this.hostModelProvider.get()
    } catch {
      console.warn('[codex-accounts] Failed to read canonical provider config')
      return null
    }
  }

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

  /** The provider check at account add reads a WSL home's distro config off the main thread. */
  async readForManagedHome(managedHomePath: string): Promise<CanonicalCodexConfig | null> {
    const wslInfo = parseWslUncPath(managedHomePath)
    if (!wslInfo) {
      return this.readHostConfig()
    }
    const wslSystemHome = wslSystemCodexHome(wslInfo.linuxPath)
    if (!wslSystemHome) {
      return null
    }
    const sourceHomePath = toWindowsWslPath(wslSystemHome, wslInfo.distro)
    try {
      return {
        contents: await readFile(join(sourceHomePath, 'config.toml'), 'utf-8'),
        sourceHomePath
      }
    } catch (error) {
      if (!isDefinitiveAbsence(error)) {
        console.warn('[codex-accounts] Failed to read WSL canonical config:', error)
      }
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

  /** Host homes sync before this returns; WSL homes sync in one helper run per distro. */
  private async syncToManagedHomes(): Promise<void> {
    const pending: Promise<void>[] = []
    const wslHomes = new Map<string, { distro: string; accounts: CodexManagedAccount[] }>()
    const warn = (error: unknown): void =>
      console.warn('[codex-accounts] Failed to sync managed config:', error)
    for (const account of this.store.getSettings().codexManagedAccounts) {
      const distro = parseWslUncPath(account.managedHomePath)?.distro
      if (distro) {
        // A stopped distro waits for launch preparation, which syncs that home before use (E9).
        if (wasWslDistroLastSeenRunningSettled(distro, { maxAgeMs: WSL_UNC_RUNNING_LEASE_MS })) {
          const group = wslHomes.get(distro.toLowerCase()) ?? { distro, accounts: [] }
          group.accounts.push(account)
          wslHomes.set(distro.toLowerCase(), group)
        }
        continue
      }
      try {
        const synced = this.syncIntoManagedHome(account.managedHomePath, undefined, account.id)
        if (synced) {
          pending.push(synced.catch(warn))
        }
      } catch (error) {
        warn(error)
      }
    }
    for (const { distro, accounts } of wslHomes.values()) {
      pending.push(this.syncWslHomes(distro, accounts, { forLaunch: false }).catch(warn))
    }
    await Promise.all(pending)
  }

  /** Synchronous for a home whose ownership check is; otherwise the promise of its sync. */
  private syncIntoManagedHome(
    managedHomePath: string,
    canonicalConfig?: CanonicalCodexConfig | null,
    expectedAccountId?: string
  ): Promise<void> | undefined {
    const distro = parseWslUncPath(managedHomePath)?.distro
    if (distro) {
      // Registration is a user act, so it may start the distro.
      return this.syncWslHomes(distro, [{ id: expectedAccountId, managedHomePath }], {
        forLaunch: true
      })
    }
    const hostConfig = canonicalConfig === undefined ? this.readHostConfig() : canonicalConfig
    if (hostConfig === null) {
      // Guard long host homes even without source config.
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
          systemHomePath: hostConfig.sourceHomePath
        })
    )
  }

  /** The distro's helper syncs every listed home against its ~/.codex in one run. */
  private async syncWslHomes(
    distro: string,
    accounts: readonly { id?: string; managedHomePath: string }[],
    options: { forLaunch: boolean }
  ): Promise<void> {
    // One account's unreadable home must not hold back the others in its distro.
    const settled = await Promise.allSettled(
      accounts.map(async (account) => {
        const runtimeHomePath = await this.assertManagedHomePath(
          account.managedHomePath,
          account.id
        )
        // Ownership answers a home stored on a drive (/mnt/c) in its drive spelling.
        const linuxRuntimeHome =
          parseWslUncPath(runtimeHomePath)?.linuxPath ??
          (/^[A-Za-z]:[\\/]/.test(runtimeHomePath) ? toLinuxPath(runtimeHomePath) : null)
        const linuxSystemHome = wslSystemCodexHome(
          parseWslUncPath(account.managedHomePath)?.linuxPath ?? ''
        )
        return linuxRuntimeHome && linuxSystemHome
          ? { runtimeHomePath, linuxRuntimeHome, linuxSystemHome }
          : null
      })
    )
    const owned: { runtimeHomePath: string; linuxRuntimeHome: string; linuxSystemHome: string }[] =
      []
    for (const result of settled) {
      if (result.status === 'rejected') {
        console.warn('[codex-accounts] Failed to sync managed config:', result.reason)
      } else if (result.value) {
        owned.push(result.value)
      }
    }
    const linuxSystemHome = owned[0]?.linuxSystemHome
    if (!linuxSystemHome) {
      return
    }
    await syncWslCodexConfigInDistro({
      distro,
      linuxSystemHome,
      // Homes of another guest user would sync against the wrong ~/.codex.
      homes: owned.filter((home) => home.linuxSystemHome === linuxSystemHome),
      forLaunch: options.forLaunch
    })
  }

  private readHostConfigContents(configPath: string): string {
    return readFileSync(configPath, 'utf-8')
  }

  private readHostConfig(): CanonicalCodexConfig | null {
    const sourceHomePath = join(homedir(), '.codex')
    const primaryConfigPath = join(sourceHomePath, 'config.toml')
    if (!existsSync(primaryConfigPath)) {
      return null
    }
    try {
      return { contents: this.readHostConfigContents(primaryConfigPath), sourceHomePath }
    } catch (error) {
      console.warn('[codex-accounts] Failed to read canonical config:', error)
      return null
    }
  }
}

/** The guest user's ~/.codex for a managed home under its ~/.local/share/orca/codex-accounts. */
function wslSystemCodexHome(linuxManagedHome: string): string | null {
  const markerIndex = linuxManagedHome.indexOf(WSL_MANAGED_ROOT_MARKER)
  return markerIndex === -1 ? null : `${linuxManagedHome.slice(0, markerIndex)}/.codex`
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
