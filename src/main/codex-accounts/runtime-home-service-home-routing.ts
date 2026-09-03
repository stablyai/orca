import { posix as pathPosix } from 'node:path'
import { parseWslUncPath, toLinuxPath, toWindowsWslUncPath } from '../../shared/wsl-paths'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { getDefaultWslDistro, getWslHome } from '../wsl'
import {
  getSystemCodexHomePath,
  syncCodexGlobalInstructionsIntoManagedHome,
  syncSystemCodexResourcesIntoManagedHome
} from '../codex/codex-home-paths'
import { syncSystemConfigIntoManagedCodexHome } from '../codex/codex-config-mirror'
import {
  getWslSelectionKey,
  normalizeCodexRuntimeSelection,
  type CodexAccountSelectionTarget
} from './runtime-selection'
import { hasCustomCodexHomeOverrideForLaunch } from '../codex/codex-real-home-path'
import {
  hasRecordedLegacySharedCodexPane,
  getCodexPaneAccount,
  type CodexPaneHomeRoute
} from '../codex/codex-pane-account-registry'
import { isShellStartupEnvProbeSupported } from '../pty/shell-startup-env'
import { ManagedCodexHomeTemporarilyUnavailableError } from './host-codex-managed-home-ownership'
import { syncLegacySharedCodexConfigForRetainedPanes } from './legacy-shared-config-compatibility'
import type { CodexManagedAccount } from '../../shared/managed-account-types'
import type { CodexRateLimitHomeResolution } from './runtime-home-service-types'
import { CodexRuntimeHomeManagedHome } from './runtime-home-service-managed-home'

export abstract class CodexRuntimeHomeRouting extends CodexRuntimeHomeManagedHome {
  getHostCodexHomePathsForSessionDiscovery(): string[] {
    const homes = [this.getRuntimeHomePath()]
    if (this.isHostSystemDefaultRealHome() || this.getSelfContainedManagedHostAccount()) {
      // Why: nested Orca processes can retain an ambient managed CODEX_HOME.
      // Per-account lanes no longer bridge real-home history into the shared
      // mirror, so include the real root for both directly-routed host lanes.
      homes.push(getSystemCodexHomePath())
    }
    // Why: account-scoped rollouts live in each account's own home, including WSL.
    for (const perAccountHome of this.getManagedAccountHomesForSessionDiscovery()) {
      homes.push(perAccountHome)
    }
    return homes.filter((home, index) => homes.indexOf(home) === index)
  }

  /**
   * The account-owned CODEX_HOME the current HOST selection runs against, or
   * null when the selection is not routed to one (system default, or a WSL
   * account, whose home lives inside the distro).
   *
   * Read-only on purpose: session discovery ranks homes with this before any
   * launch prep, so it must create no directories and sync no auth.
   */
  getSelectedHostAccountCodexHomePath(): string | null {
    const selfContainedAccount = this.getSelfContainedManagedHostAccount()
    return selfContainedAccount
      ? this.getTrustedSelfContainedManagedHomePath(selfContainedAccount)
      : null
  }

  /**
   * Same selection, but an unreadable home refuses instead of collapsing to
   * `null`. Session resume must not read "no managed selection" out of a failed
   * marker stat: another account's readable alias would then win the legacy
   * rescan and the pane would resume under that account's credentials while the
   * UI still shows this one (#STA-4422).
   */
  resolveSelectedHostAccountCodexHomePathForResume(): string | null {
    const selfContainedAccount = this.getSelfContainedManagedHostAccount()
    if (!selfContainedAccount) {
      return null
    }
    const resolved = this.resolveSelfContainedManagedHome(selfContainedAccount)
    if (resolved.kind === 'indeterminate') {
      throw new ManagedCodexHomeTemporarilyUnavailableError()
    }
    if (resolved.kind === 'untrusted') {
      this.clearSelfContainedManagedSelection(selfContainedAccount)
      return null
    }
    return resolved.homePath
  }

  /** Trust-gates host previews without changing WSL routing or durable account state. */
  resolveCodexManagedAccountHomeForInactiveFetch(
    account: CodexManagedAccount
  ): { kind: 'ready'; homePath: string } | { kind: 'skip' } {
    if (account.managedHomeRuntime === 'wsl' || this.getWslManagedHomePath(account)) {
      return { kind: 'ready', homePath: account.managedHomePath }
    }
    const resolved = this.resolveSelfContainedManagedHome(account)
    return resolved.kind === 'owned'
      ? { kind: 'ready', homePath: resolved.homePath }
      : { kind: 'skip' }
  }

  getSelectedHostCodexHomeRoute(): CodexPaneHomeRoute {
    if (this.getSelfContainedManagedHostAccount()) {
      return 'account-home'
    }
    return this.isHostSystemDefaultRealHome() ? 'real-home' : 'shared-home'
  }

  getRetainedHostCodexHookHomePaths(ptyIds: readonly string[]): string[] {
    const settings = this.store.getSettings()
    const homes = new Map<string, string>()
    for (const ptyId of ptyIds) {
      const record = getCodexPaneAccount(ptyId)
      if (!record || record.selectionKey !== 'host') {
        continue
      }
      if (
        record.homeRoute === undefined ||
        record.homeRoute === 'shared-home' ||
        record.homeRoute === 'custom-home'
      ) {
        const homePath = this.getRuntimeHomePath()
        homes.set(normalizeRuntimePathForComparison(homePath), homePath)
        continue
      }
      if (record.homeRoute !== 'account-home' || !record.accountId) {
        continue
      }
      const account = settings.codexManagedAccounts.find(
        (candidate) => candidate.id === record.accountId
      )
      if (!account || this.getWslManagedHomePath(account)) {
        continue
      }
      const homePath = this.getTrustedSelfContainedManagedHomePath(account)
      if (homePath) {
        homes.set(normalizeRuntimePathForComparison(homePath), homePath)
      }
    }
    return [...homes.values()]
  }

  // Why: the real-home hook installer flips this gate off when the trust-grant
  // client reports the host incapable, keeping that host byte-identical to the
  // managed lane instead of shipping status-blind panes.
  protected realHomeLaneGate: () => boolean = () => true

  setRealHomeLaneGate(gate: () => boolean): void {
    this.realHomeLaneGate = gate
  }

  // Why: real-home routing applies only to the host system-default selection.
  // Managed accounts run in their own homes; Windows (no shell-startup probe)
  // and custom CODEX_HOMEs stay on the mirror until cleanup can be tracked
  // across old homes.
  isHostSystemDefaultRealHomeSelected(launchEnv?: NodeJS.ProcessEnv): boolean {
    const settings = this.store.getSettings()
    if (
      normalizeCodexRuntimeSelection(settings).host !== null ||
      !isShellStartupEnvProbeSupported()
    ) {
      return false
    }
    return !hasCustomCodexHomeOverrideForLaunch(launchEnv)
  }

  isHostSystemDefaultRealHome(launchEnv?: NodeJS.ProcessEnv): boolean {
    return this.isHostSystemDefaultRealHomeSelected(launchEnv) && this.realHomeLaneGate()
  }

  reconcileLegacySharedHomeForRetainedPanes(): void {
    if (!this.isHostSystemDefaultRealHome() || !hasRecordedLegacySharedCodexPane()) {
      return
    }
    this.syncLegacySharedSystemDefaultAuthForRetainedPanes()
    syncLegacySharedCodexConfigForRetainedPanes()
  }

  /** Preserve refreshed auth from retained legacy WSL panes before restart. */
  async syncActiveWslSelectionsBeforeRestart(): Promise<void> {
    if (process.platform !== 'win32') {
      return
    }
    const settings = this.store.getSettings()
    const drains: Promise<void>[] = []
    for (const [selectedDistroKey, accountId] of Object.entries(
      normalizeCodexRuntimeSelection(settings).wsl
    )) {
      if (!accountId) {
        continue
      }
      const account = this.getActiveAccount(settings.codexManagedAccounts, accountId)
      if (!account || account.managedHomeRuntime !== 'wsl') {
        continue
      }
      const distro =
        selectedDistroKey === getWslSelectionKey(null)
          ? account.wslDistro?.trim() || null
          : selectedDistroKey.trim() || null
      if (distro) {
        drains.push(this.startLegacyWslAuthDrain({ runtime: 'wsl', wslDistro: distro }))
      }
    }
    await Promise.all(drains)
  }

  protected getWslSystemCodexHomePath(target: CodexAccountSelectionTarget): string | null {
    if (process.platform !== 'win32') {
      return null
    }
    const distro = target.wslDistro?.trim() || getDefaultWslDistro()
    if (!distro) {
      return null
    }
    const home = getWslHome(distro)
    if (home && /^[A-Za-z]:[\\/]/.test(home)) {
      const linuxHome = toLinuxPath(home).trim()
      return linuxHome.startsWith('/')
        ? toWindowsWslUncPath(pathPosix.join(linuxHome, '.codex'), distro)
        : null
    }
    return home ? this.joinWslPath(home, '.codex') : null
  }

  protected finishWslLaunchPreparation(
    target: CodexAccountSelectionTarget,
    homePath: string | null
  ): void {
    this.syncWslConfigAndGlobalInstructionsForLaunch(target, homePath)
    this.startWslSessionBridgeForLaunch(target, homePath)
  }

  protected syncWslConfigAndGlobalInstructionsForLaunch(
    target: CodexAccountSelectionTarget,
    runtimeHomePath: string | null
  ): void {
    if (!runtimeHomePath) {
      return
    }
    const distro =
      parseWslUncPath(runtimeHomePath)?.distro || target.wslDistro?.trim() || getDefaultWslDistro()
    if (!distro) {
      return
    }
    const systemHomePath = this.getWslSystemCodexHomePath({ runtime: 'wsl', wslDistro: distro })
    if (!systemHomePath || systemHomePath === runtimeHomePath) {
      return
    }
    // Why: WSL uses a distro-local CODEX_HOME, so host resource mirroring can't provide the distro user's global instructions.
    syncCodexGlobalInstructionsIntoManagedHome({
      systemHomePath,
      managedHomePath: runtimeHomePath
    })
    syncSystemConfigIntoManagedCodexHome({
      runtimeHomePath,
      systemHomePath,
      systemConfigDir: toLinuxPath(systemHomePath)
    })
  }

  // Why: `null` is a real value here — it means "use the system-default lane".
  // A skipped poll needs its own channel or the fetcher silently retargets the
  // user's real ~/.codex (#STA-4422).
  prepareForRateLimitFetch(target?: CodexAccountSelectionTarget): CodexRateLimitHomeResolution {
    if (target?.runtime === 'wsl') {
      const wslTarget = this.resolveWslDefaultTarget(target)
      return {
        kind: 'ready',
        codexHomePath: this.getPreparedWslRateLimitHomePath(wslTarget)
      }
    }
    const selfContainedAccount = this.getSelfContainedManagedHostAccount()
    if (selfContainedAccount) {
      const resolved = this.resolveSelfContainedManagedHome(selfContainedAccount)
      if (resolved.kind === 'owned') {
        // Why: the quota fetch reads the account's own auth.json in place; no
        // shared-home hot-swap or per-poll resource relink (that is launch prep).
        return { kind: 'ready', codexHomePath: resolved.homePath }
      }
      if (resolved.kind === 'indeterminate') {
        // Why: returning null here would NOT skip — the fetcher maps null to
        // ~/.codex and would probe the user's real home with a token-refreshing
        // app-server. Skip the poll outright and keep the selection.
        return { kind: 'skip' }
      }
      this.clearSelfContainedManagedSelection(selfContainedAccount)
    }
    if (this.isHostSystemDefaultRealHome()) {
      // Why: null lets the fetcher fall back to the main process's inherited
      // CODEX_HOME before ~/.codex. Nested Orca launches can inherit the
      // managed home, restarting the background OAuth conflict (#5370), so
      // pin this non-interactive lane to the native home explicitly.
      if (hasRecordedLegacySharedCodexPane()) {
        this.syncLegacySharedSystemDefaultAuthForRetainedPanes()
      }
      return { kind: 'ready', codexHomePath: getSystemCodexHomePath() }
    }
    this.syncForCurrentSelection()
    syncSystemCodexResourcesIntoManagedHome()
    syncSystemConfigIntoManagedCodexHome()
    return { kind: 'ready', codexHomePath: this.getRuntimeHomePath() }
  }
}
