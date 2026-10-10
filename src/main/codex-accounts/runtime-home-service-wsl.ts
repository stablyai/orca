import { join, win32 as pathWin32 } from 'node:path'
import { parseWslUncPath, toLinuxPath, toWindowsWslUncPath } from '../../shared/wsl-paths'
import {
  getCodexSelectionLaneKey,
  getSelectedCodexAccountIdForTarget,
  type CodexAccountSelectionTarget
} from './runtime-selection'
import { getDefaultWslDistro, getWslHome } from '../wsl'
import { hasRecordedLegacyWslCodexPane } from '../codex/codex-pane-account-registry'
import {
  startLegacyWslRuntimeAuthDrain,
  type LegacyWslRuntimeAuthDestination
} from './legacy-wsl-runtime-auth-drain'
import { readWslCodexAuths, type WslCodexAuthRead } from './wsl-codex-auth-batch-reader'
import type { CodexManagedAccount } from '../../shared/managed-account-types'
import { CodexRuntimeHomeWslCore } from './runtime-home-service-wsl-core'

export abstract class CodexRuntimeHomeWsl extends CodexRuntimeHomeWslCore {
  protected getPreparedWslRateLimitHomePath(target: CodexAccountSelectionTarget): string | null {
    return this.getWslCodexHomePathForSelection(target)
  }

  protected getWslCodexHomePathForSelection(target: CodexAccountSelectionTarget): string | null {
    const settings = this.store.getSettings()
    const account = this.getActiveAccount(
      settings.codexManagedAccounts,
      getSelectedCodexAccountIdForTarget(settings, target)
    )
    if (account) {
      const targetDistro = this.resolveWslDefaultTarget(target).wslDistro?.trim()
      const accountHome = this.getWslLaunchCodexHomePath(account, targetDistro)
      if (accountHome) {
        return accountHome
      }
    }
    return this.getWslSystemCodexHomePath(target)
  }

  protected getWslLaunchCodexHomePath(
    account: CodexManagedAccount,
    targetDistro: string | undefined
  ): string | null {
    const wslHome = this.getWslManagedHomeIdentity(account)
    if (!wslHome) {
      return null
    }
    const accountDistro = wslHome.distro
    if (targetDistro && accountDistro.toLowerCase() !== targetDistro.toLowerCase()) {
      return null
    }
    if (/^[A-Za-z]:[\\/]/.test(account.managedHomePath)) {
      return toWindowsWslUncPath(wslHome.linuxHomePath, accountDistro)
    }
    return account.managedHomePath || toWindowsWslUncPath(wslHome.linuxHomePath, accountDistro)
  }

  protected startLegacyWslAuthDrain(
    target: CodexAccountSelectionTarget,
    options: { throwOnFailure?: boolean } = {}
  ): Promise<void> {
    if (process.platform !== 'win32') {
      return Promise.resolve()
    }
    const distro = target.wslDistro?.trim() || getDefaultWslDistro()
    if (!distro) {
      return Promise.resolve()
    }
    const guestHome = getWslHome(distro)
    const guestHomeLinuxPath = guestHome ? toLinuxPath(guestHome).trim() : ''
    if (!guestHomeLinuxPath.startsWith('/')) {
      return Promise.resolve()
    }
    let legacyPanePresent = true
    try {
      legacyPanePresent = hasRecordedLegacyWslCodexPane(getCodexSelectionLaneKey(target))
    } catch (error) {
      // Why: unknown pane liveness must preserve the source, but promotion can
      // still keep the direct home from launching stale auth.
      console.warn('[codex-wsl-auth-drain] Pane registry unavailable; preserving source:', error)
    }
    return startLegacyWslRuntimeAuthDrain(
      {
        distro,
        guestHomeLinuxPath,
        legacyPanePresent,
        resolveDestination: (runtimeAuthContents) =>
          this.resolveLegacyWslAuthDestination(distro, runtimeAuthContents)
      },
      options
    )
  }

  protected async resolveLegacyWslAuthDestination(
    distro: string,
    runtimeAuthContents: string
  ): Promise<LegacyWslRuntimeAuthDestination | null> {
    const accountHomes = this.store.getSettings().codexManagedAccounts.flatMap((account) => {
      const wslHome = this.getWslManagedHomeIdentity(account)
      return wslHome?.distro.toLowerCase() === distro.toLowerCase()
        ? [{ account, linuxPath: wslHome.linuxHomePath }]
        : []
    })
    const accounts = accountHomes.map(({ account }) => account)
    const systemHome = this.getWslSystemCodexHomePath({ runtime: 'wsl', wslDistro: distro })
    const parsedSystemHome = systemHome ? parseWslUncPath(systemHome) : null
    let reads: WslCodexAuthRead[]
    try {
      reads = await readWslCodexAuths(distro, [
        ...accountHomes.map(({ linuxPath }) => linuxPath),
        ...(parsedSystemHome ? [parsedSystemHome.linuxPath] : [])
      ])
    } catch {
      reads = accountHomes.map(() => ({ kind: 'unreadable' }))
      if (parsedSystemHome) {
        reads.push({ kind: 'unreadable' })
      }
    }
    const authReads = new Map<string, WslCodexAuthRead>(
      accountHomes.map(({ account }, index) => [account.id, reads[index] ?? { kind: 'unreadable' }])
    )
    const match = this.findManagedAccountForRuntimeAuth(runtimeAuthContents, undefined, {
      accounts,
      authReads
    })
    if (match.kind === 'ambiguous') {
      return null
    }
    if (match.kind === 'matched') {
      const accountHome = accountHomes.find(({ account }) => account.id === match.account.id)
      if (!accountHome) {
        return null
      }
      return {
        authContents: match.managedAuthContents,
        linuxHomePath: accountHome.linuxPath
      }
    }

    if (!systemHome || !parsedSystemHome) {
      return null
    }
    const systemAuth = reads[accountHomes.length] ?? { kind: 'unreadable' }
    if (systemAuth.kind !== 'present') {
      return null
    }
    return this.runtimeAuthMatchesSystemDefaultIdentity(runtimeAuthContents, systemAuth.contents)
      ? { authContents: systemAuth.contents, linuxHomePath: parsedSystemHome.linuxPath }
      : null
  }

  protected joinWslPath(basePath: string, ...segments: string[]): string {
    return parseWslUncPath(basePath)
      ? pathWin32.join(basePath, ...segments)
      : join(basePath, ...segments)
  }

  protected resolveWslDefaultTarget(
    target: CodexAccountSelectionTarget
  ): CodexAccountSelectionTarget {
    if (target.runtime !== 'wsl' || target.wslDistro?.trim()) {
      return target
    }
    const defaultDistro = getDefaultWslDistro()
    return defaultDistro ? { runtime: 'wsl', wslDistro: defaultDistro } : target
  }
}
