import { copyFileSync, existsSync, lstatSync, mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { ClaudeManagedAccount } from '../../../shared/managed-account-types'
import { resolveLocalAccountRuntimeTarget } from '../../../shared/local-account-runtime'
import { parseWslUncPath } from '../../../shared/wsl-paths'
import { getDefaultWslDistro, getWslHome } from '../../wsl'
import {
  getSelectedClaudeAccountIdForTarget,
  normalizeClaudeAccountSelectionTarget,
  type ClaudeAccountSelectionTarget
} from '../runtime-selection'
import { ClaudeRuntimeAuthSnapshotRestore } from './runtime-auth-snapshot-restore'
import { CLAUDE_MANAGED_AUTH_UNOWNED_PROVENANCE } from './runtime-auth-types'
import type { ClaudeRuntimeAuthPreparation } from './runtime-auth-types'
import { resolveOwnedClaudeManagedAuthPath } from '../managed-auth-path'

export class ClaudeRuntimeAuthPreparationService extends ClaudeRuntimeAuthSnapshotRestore {
  protected getPreparation(target?: ClaudeAccountSelectionTarget): ClaudeRuntimeAuthPreparation {
    const settings = this.store.getSettings()
    const paths = this.pathResolver.getRuntimePaths()
    const normalizedTarget = this.resolveWslDefaultTarget(
      target ?? this.getDefaultAccountSelectionTarget(settings)
    )
    const activeAccountId = getSelectedClaudeAccountIdForTarget(settings, normalizedTarget)
    const activeAccount = this.getActiveAccount(settings.claudeManagedAccounts, activeAccountId)
    // An explicit user config root is authoritative; account selection must not
    // silently redirect a pane away from it.
    if (process.env.CLAUDE_CONFIG_DIR?.trim()) {
      return {
        configDir: paths.configDir,
        runtime: normalizedTarget.runtime,
        wslDistro: normalizedTarget.wslDistro,
        wslLinuxConfigDir: null,
        envPatch: paths.envPatch,
        stripAuthEnv: false,
        provenance: 'system:explicit-config-dir'
      }
    }
    if (
      normalizeClaudeAccountSelectionTarget(normalizedTarget).runtime === 'wsl' &&
      activeAccount?.managedAuthRuntime === 'wsl' &&
      activeAccount.wslLinuxAuthPath
    ) {
      return {
        configDir: activeAccount.managedAuthPath,
        runtime: 'wsl',
        wslDistro: activeAccount.wslDistro ?? null,
        wslLinuxConfigDir: activeAccount.wslLinuxAuthPath,
        envPatch: {
          CLAUDE_CONFIG_DIR: activeAccount.wslLinuxAuthPath,
          ORCA_CLAUDE_CONFIG_DIR: activeAccount.wslLinuxAuthPath
        },
        stripAuthEnv: true,
        provenance: `managed:${activeAccount.id}:wsl:${activeAccount.wslDistro ?? ''}`
      }
    }
    if (normalizeClaudeAccountSelectionTarget(normalizedTarget).runtime === 'wsl') {
      const distro =
        normalizeClaudeAccountSelectionTarget(normalizedTarget).wslDistro ?? getDefaultWslDistro()
      const wslHome = distro ? getWslHome(distro) : null
      const wslHomeInfo = wslHome ? parseWslUncPath(wslHome) : null
      if (distro && wslHome && wslHomeInfo) {
        const windowsConfigDir = join(wslHome, '.claude')
        const linuxConfigDir = `${wslHomeInfo.linuxPath.replace(/\/$/, '')}/.claude`
        return {
          configDir: windowsConfigDir,
          runtime: 'wsl',
          wslDistro: distro,
          wslLinuxConfigDir: linuxConfigDir,
          envPatch: {},
          stripAuthEnv: true,
          provenance: `wsl:${distro}:system`
        }
      }
      return {
        configDir: paths.configDir,
        runtime: 'wsl',
        wslDistro: normalizeClaudeAccountSelectionTarget(normalizedTarget).wslDistro,
        wslLinuxConfigDir: null,
        envPatch: {},
        stripAuthEnv: true,
        provenance: `wsl:${normalizeClaudeAccountSelectionTarget(normalizedTarget).wslDistro ?? '__default__'}:system`
      }
    }
    let managedRoutingFailed = false
    if (activeAccount?.managedAuthRuntime === 'host') {
      const managedPath = resolveOwnedClaudeManagedAuthPath(
        activeAccount.id,
        activeAccount.managedAuthPath,
        { adoptLegacyMarker: true }
      )
      if (managedPath) {
        if (!provisionClaudeManagedHome(paths.configDir, managedPath)) {
          console.warn(
            '[claude-runtime-auth] Refusing managed Claude routing after home provisioning failed'
          )
          managedRoutingFailed = true
        } else {
          return {
            configDir: managedPath,
            runtime: 'host',
            wslDistro: null,
            wslLinuxConfigDir: null,
            envPatch: {
              CLAUDE_CONFIG_DIR: managedPath,
              ORCA_CLAUDE_CONFIG_DIR: managedPath
            },
            stripAuthEnv: true,
            provenance: `managed:${activeAccount.id}`
          }
        }
      } else {
        managedRoutingFailed = true
      }
    }
    return {
      configDir: paths.configDir,
      runtime: 'host',
      wslDistro: null,
      wslLinuxConfigDir: null,
      envPatch: paths.envPatch,
      stripAuthEnv: Boolean(activeAccountId && activeAccount?.managedAuthRuntime === 'host'),
      managedRefreshDeferredByLivePty: Boolean(
        activeAccountId &&
        activeAccount?.managedAuthRuntime === 'host' &&
        this.managedRefreshDeferredByLivePtyAccountId === activeAccountId
      ),
      // Why: this pane is on the personal login; labelling it `managed:` hides that from
      // every consumer, including the usage lane that reports the numbers.
      provenance: managedRoutingFailed
        ? CLAUDE_MANAGED_AUTH_UNOWNED_PROVENANCE
        : activeAccountId && activeAccount?.managedAuthRuntime === 'host'
          ? `managed:${activeAccountId}`
          : 'system'
    }
  }

  protected getActiveAccount(
    accounts: ClaudeManagedAccount[],
    activeAccountId: string | null
  ): ClaudeManagedAccount | null {
    if (!activeAccountId) {
      return null
    }
    return accounts.find((account) => account.id === activeAccountId) ?? null
  }

  protected getDefaultAccountSelectionTarget(
    settings = this.store.getSettings()
  ): ClaudeAccountSelectionTarget {
    // Why: Windows auth follows the resolved account runtime; stale cross-platform WSL pins must stay local-host.
    const resolved = resolveLocalAccountRuntimeTarget(settings)
    if (process.platform === 'win32' && resolved.runtime === 'wsl') {
      return { runtime: 'wsl', wslDistro: resolved.wslDistro }
    }
    return { runtime: 'host' }
  }

  protected resolveWslDefaultTarget(
    target?: ClaudeAccountSelectionTarget
  ): ClaudeAccountSelectionTarget {
    if (target?.runtime !== 'wsl' || target.wslDistro?.trim()) {
      return target ?? { runtime: 'host' }
    }
    const defaultDistro = getDefaultWslDistro()
    return defaultDistro ? { runtime: 'wsl', wslDistro: defaultDistro } : target
  }
}

// Keep account homes useful without copying credential-bearing runtime state.
// Missing user resources are linked once; existing files remain user-owned.
function provisionClaudeManagedHome(systemConfigDir: string, managedPath: string): boolean {
  if (systemConfigDir === managedPath) {
    return true
  }
  const resources = ['settings.json', 'CLAUDE.md', 'projects', 'plugins'] as const
  let succeeded = true
  for (const name of resources) {
    const source = join(systemConfigDir, name)
    const target = join(managedPath, name)
    if (!existsSync(source) || existsSync(target)) {
      continue
    }
    try {
      const sourceIsDirectory = lstatSync(source).isDirectory()
      mkdirSync(managedPath, { recursive: true, mode: 0o700 })
      if (process.platform === 'win32') {
        if (sourceIsDirectory) {
          symlinkSync(source, target, 'junction')
        } else {
          copyFileSync(source, target)
        }
      } else {
        symlinkSync(source, target, sourceIsDirectory ? 'dir' : 'file')
      }
    } catch {
      // Do not route into a partially provisioned home.
      succeeded = false
    }
  }
  return succeeded
}
