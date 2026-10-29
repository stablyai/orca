import { BROWSER_GOOGLE_COOKIE_CLEAR_CAPABILITY } from '../../shared/browser-runtime-capabilities'
import { OrcaRuntimeWithGetRuntimeId } from './workspaces/session-hosts/get-runtime-id'
import type { RuntimeDegradation, RuntimeStatus } from '../../shared/runtime-types'
import {
  runtimeBrowserCommandsFactoryIsHeadless,
  runtimeBrowserCommandsFactorySupportsGoogleCookieClear,
  runtimeBrowserCommandsFactorySupportsClientHosting,
  runtimeBrowserUnavailableCause
} from './runtime-browser-commands-factory'
import { isBrowserIdentityModeStoreInitialized } from '../browser/browser-identity-mode-store'
import { servesLocalWslMigrationSource } from '../orcad/orcad-migration-wsl-destination'
import { ORCAD_MIGRATION_LOCAL_WSL_SOURCE_RUNTIME_CAPABILITY } from '../../shared/orcad-runtime-capabilities'
import { advertisedOrcadMigrationDestinationCapabilities } from '../orcad/orcad-migration-destination-capabilities'
import { USAGE_CREDENTIALS_RUNTIME_CAPABILITY } from '../../shared/account-runtime-capabilities'
import {
  BROWSER_CERTIFICATE_TRUST_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_HEADLESS_RUNTIME_CAPABILITY,
  BROWSER_IDENTITY_RUNTIME_CAPABILITY,
  BROWSER_TAB_CREATE_KNOWN_ID_RUNTIME_CAPABILITY,
  MANAGED_SERVER_RUNTIME_CAPABILITY,
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY,
  RUNTIME_CAPABILITIES,
  RUNTIME_PROTOCOL_VERSION,
  SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY,
  TERMINAL_PROMPT_DELIVERY_RUNTIME_CAPABILITY,
  TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY
} from '../../shared/protocol-version'
import {
  BROWSER_UNAVAILABLE_ERROR_CODE,
  browserUnavailableMessage
} from '../../shared/runtime-types'
import { MOBILE_WEB_BUNDLE_CAPABILITY } from '../../shared/mobile-web-bundle/mobile-web-bundle-capability'
import { loadBundledMobileWebBundle } from './bundled-mobile-web-bundle'
import { runtimeTerminalDegradation } from './native-terminal-availability'
import { isWindowsProcessStartTimeAvailable } from '../windows/windows-process-table'
import type { RuntimeWorktreeLifecycleEvent } from './orca-runtime-core'
import { WORKTREE_CREATE_RESULT_TTL_MS } from './orca-runtime-core'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import type {
  AutomaticWorkResumeOutcome,
  AutomaticWorkStatus
} from '../../shared/host-spawn-admission'
import type { RuntimeNotifier } from './runtime-notifier-contract'
import type {
  AutomationsChangedPayload,
  RuntimeClientEvent
} from '../../shared/runtime-client-events'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { wakeFolderRepoGitUpgradeWatch } from '../ipc/folder-repo-git-upgrade-wake'
import { runWorktreeChangeInvalidators } from '../ipc/worktree-change-invalidators'
import { MACHINE_NAME_PUBLISH_WAIT_MS } from './runtime-machine-name'
import { getManagedServerActions } from './managed-server-actions-registry'
import type { WorktreeSortOrderUpdate } from '../../shared/worktree/sort-order-update'
import { isDesktopBrowserBridgeHostEnabled } from './desktop-browser-bridge/desktop-browser-bridge-registry'
import { DESKTOP_BROWSER_BRIDGE_RUNTIME_CAPABILITY } from '../../shared/desktop-browser-bridge-protocol'
import { darkSwitchRuntimeCapabilities } from './dark-switch-runtime-capabilities'
import { supportsDurableTerminalPromptDelivery } from './durable-terminal-prompt-delivery-support'

type RuntimeStatusHost = {
  getAvailableAuthoritativeWindow(): unknown
  getUsageRateLimits(): unknown
  getRecordedTerminalSleepHandles(
    ptyIds: Iterable<string>,
    terminalHandlesByPtyId: Readonly<Record<string, readonly string[]>>
  ): string[]
}

export abstract class OrcaRuntimeWithGetStatus extends OrcaRuntimeWithGetRuntimeId {
  protected abstract pruneUnregisteredWorktreeScans(): void

  private asRuntimeStatusHost(): RuntimeStatusHost {
    return this as unknown as RuntimeStatusHost
  }

  getStatus(): RuntimeStatus {
    // Advertise screencast for renderer/offscreen backends; headless ownership prevents client-local fallback.
    const statusHost = this.asRuntimeStatusHost()
    const hasRenderer = Boolean(statusHost.getAvailableAuthoritativeWindow())
    const hasOffscreen = !hasRenderer && Boolean(this.offscreenBrowserBackend)
    const hasHeadlessCommands = runtimeBrowserCommandsFactoryIsHeadless()
    const canBrowse = hasRenderer || hasOffscreen
    const canHostClientPages = runtimeBrowserCommandsFactorySupportsClientHosting()
    // TEMPORARY compatibility field: older clients otherwise re-probe WSL capabilities indefinitely.
    const windowsProcessStartTimeAvailable =
      process.platform === 'win32' && isWindowsProcessStartTimeAvailable()
    const capabilities: NonNullable<RuntimeStatus['capabilities']> = RUNTIME_CAPABILITIES.filter(
      (capability) =>
        (capability !== BROWSER_GOOGLE_COOKIE_CLEAR_CAPABILITY ||
          runtimeBrowserCommandsFactorySupportsGoogleCookieClear()) &&
        (capability !== 'browser.screencast.v1' || canBrowse) &&
        (capability !== BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY || canHostClientPages) &&
        (capability !== BROWSER_TAB_CREATE_KNOWN_ID_RUNTIME_CAPABILITY ||
          canBrowse ||
          hasHeadlessCommands ||
          canHostClientPages) &&
        // Nested-runtime E2E exercises legacy transport without maintaining an old binary.
        (process.env.ORCA_E2E_DISABLE_RUNTIME_SHARED_CONTROL !== '1' ||
          capability !== REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY) &&
        (process.env.ORCA_E2E_DISABLE_PAIRED_TERMINAL_PARKING !== '1' ||
          capability !== TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY) &&
        (process.env.ORCA_E2E_DISABLE_AUTHORITATIVE_SESSION_TABS_INVENTORY !== '1' ||
          capability !== SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY) &&
        (capability !== TERMINAL_PROMPT_DELIVERY_RUNTIME_CAPABILITY ||
          supportsDurableTerminalPromptDelivery()) &&
        // Only hosts running their own usage poller can consume saved keys.
        (capability !== USAGE_CREDENTIALS_RUNTIME_CAPABILITY ||
          statusHost.getUsageRateLimits() !== null)
    )
    if (hasOffscreen || hasHeadlessCommands) {
      capabilities.push(BROWSER_HEADLESS_RUNTIME_CAPABILITY)
    }
    // Only initialized identity stores can serve this process-wide, pre-ready mode.
    if (isBrowserIdentityModeStoreInitialized()) {
      capabilities.push(BROWSER_IDENTITY_RUNTIME_CAPABILITY)
    }
    // Only the daemon inside a distro can receive that distro's projects.
    if (servesLocalWslMigrationSource()) {
      capabilities.push(ORCAD_MIGRATION_LOCAL_WSL_SOURCE_RUNTIME_CAPABILITY)
    }
    // Advertise only installed blob kinds; senders refuse unsupported kinds instead of silently losing staged data.
    capabilities.push(...advertisedOrcadMigrationDestinationCapabilities())
    // Certificate proceed belongs to whichever process hosts the page, renderer or offscreen.
    if (canBrowse) {
      capabilities.push(BROWSER_CERTIFICATE_TRUST_RUNTIME_CAPABILITY)
    }
    if (getManagedServerActions()) {
      capabilities.push(MANAGED_SERVER_RUNTIME_CAPABILITY)
    }
    if (isDesktopBrowserBridgeHostEnabled()) {
      capabilities.push(DESKTOP_BROWSER_BRIDGE_RUNTIME_CAPABILITY)
    }
    capabilities.push(...darkSwitchRuntimeCapabilities())
    // Dev/serve installs may lack out/mobile-web; never advertise downloads this install cannot produce.
    if (loadBundledMobileWebBundle()) {
      capabilities.push(MOBILE_WEB_BUNDLE_CAPABILITY)
    }
    // Report the actual failure so operators are not told to fix already-correct configuration.
    const cause = canBrowse || hasHeadlessCommands ? null : runtimeBrowserUnavailableCause()
    const degradations: RuntimeDegradation[] = cause
      ? [
          {
            code: BROWSER_UNAVAILABLE_ERROR_CODE,
            capability: BROWSER_HEADLESS_RUNTIME_CAPABILITY,
            message: browserUnavailableMessage(cause.reason, cause.detail),
            reason: cause.reason,
            ...(cause.detail ? { detail: cause.detail } : {})
          }
        ]
      : []
    const terminalDegradation = runtimeTerminalDegradation()
    if (terminalDegradation) {
      degradations.push(terminalDegradation)
    }
    return {
      runtimeId: this.runtimeId,
      rendererGraphEpoch: this.rendererGraphEpoch,
      graphStatus: this.graphStatus,
      authoritativeWindowId: this.authoritativeWindowId,
      desktopWindowStatus: hasRenderer ? 'available' : this.getDesktopWindowStatusFn(),
      liveTabCount: this.tabs.size,
      liveLeafCount: this.leaves.size,
      runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
      capabilities,
      ...(degradations.length > 0 ? { degradations } : {}),
      worktreeCreateIdempotency: { dedupeTtlMs: WORKTREE_CREATE_RESULT_TTL_MS },
      ...(windowsProcessStartTimeAvailable ? { windowsProcessStartTimeAvailable } : {}),
      hostPlatform: process.platform,
      machineName: this.readMachineName(),
      terminalWindowsShell: this.store?.getSettings?.().terminalWindowsShell ?? null,
      floatingWorkspaceEnabled: this.store?.getSettings?.().floatingTerminalEnabled !== false,
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleMobileVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
    }
  }

  readMachineName(): string {
    return this.machineName.read()
  }

  /** Bound machine-name lookup; slow lookups temporarily publish hostname, then their result on the next read. */
  machineNameReady(): Promise<void> {
    return this.machineName.readyWithin(MACHINE_NAME_PUBLISH_WAIT_MS)
  }

  setPtyController(controller: RuntimePtyController | null): void {
    // Write through the main-owned PTY registry so renderer reloads cannot drift handle/process identity.
    this.ptyController = controller
  }

  /** Null when the local terminal owner has no fork gate (in-process fallback, older daemon). */
  async getAutomaticWorkStatus(): Promise<AutomaticWorkStatus | null> {
    return (await this.ptyController?.getAutomaticWorkStatus?.()) ?? null
  }

  async resumeAutomaticWork(): Promise<AutomaticWorkResumeOutcome> {
    return (await this.ptyController?.resumeAutomaticWork?.()) ?? null
  }

  setNotifier(notifier: RuntimeNotifier | null): void {
    this.notifier = notifier
    if (notifier) {
      this.repositoryForkBackfill.start()
    }
  }

  protected countTerminalSideEffectConsumingClientEventListeners(): number {
    return this.clientEvents.countTerminalSideEffectConsumers()
  }

  getTerminalSleepClientEventSnapshot(): RuntimeClientEvent[] {
    const statusHost = this.asRuntimeStatusHost()
    const events: RuntimeClientEvent[] = []
    const sleepStates = [...this.terminalSleepStateByHostWorktree.values()].sort((a, b) =>
      a.worktreeId.localeCompare(b.worktreeId)
    )
    for (const state of sleepStates) {
      const committedPtyIds = new Set(state.ptyIds)
      if (state.phase === 'stopping') {
        const pendingPtyIds = Object.keys(state.terminalHandlesByPtyId)
          .filter((ptyId) => !committedPtyIds.has(ptyId))
          .sort()
        if (pendingPtyIds.length > 0) {
          events.push({
            type: 'worktreeTerminalSleepState',
            worktreeId: state.worktreeId,
            generation: state.generation,
            phase: 'started',
            ptyIds: pendingPtyIds,
            terminalHandles: statusHost.getRecordedTerminalSleepHandles(
              pendingPtyIds,
              state.terminalHandlesByPtyId
            )
          })
        }
      }
      if (state.ptyIds.length > 0) {
        events.push({
          type: 'worktreeTerminalSleepState',
          worktreeId: state.worktreeId,
          generation: state.generation,
          phase: 'committed',
          ptyIds: [...state.ptyIds].sort(),
          terminalHandles: statusHost.getRecordedTerminalSleepHandles(
            state.ptyIds,
            state.terminalHandlesByPtyId
          )
        })
      }
    }
    return events
  }

  protected resolveNativeChatLaunchDraftOwner(
    handle: string
  ): { tabId: string; worktreeId: string } | null {
    const record = this.handles.get(handle)
    if (!record) {
      return null
    }
    if (!record.tabId.startsWith('pty:')) {
      return { tabId: record.tabId, worktreeId: record.worktreeId }
    }
    const pty = record.ptyId ? this.ptysById.get(record.ptyId) : null
    const pane = this.paneOfPty(pty)
    const tabId =
      pane.tabId && !pane.tabId.startsWith('pty:')
        ? pane.tabId
        : parsePaneKey(pane.paneKey ?? '')?.tabId
    if (!pty || !tabId || tabId.startsWith('pty:')) {
      return null
    }
    return { tabId, worktreeId: pty.worktreeId }
  }

  notifyWorktreesChanged(
    repoId: string,
    options?: {
      invalidateGitScans?: boolean
      sortOrderOnly?: boolean
      sortOrders?: WorktreeSortOrderUpdate[]
    }
  ): void {
    if (options?.invalidateGitScans !== false) {
      runWorktreeChangeInvalidators(repoId)
    }
    if (options) {
      const { sortOrders: _sortOrders, ...notifierOptions } = options
      this.notifier?.worktreesChanged(repoId, undefined, notifierOptions)
    } else {
      this.notifier?.worktreesChanged(repoId)
    }
    this.emitClientEvent({
      type: 'worktreesChanged',
      repoId,
      ...(options?.sortOrderOnly === true ? { sortOrderOnly: true } : {}),
      ...(options?.sortOrderOnly === true && options.sortOrders
        ? { sortOrders: options.sortOrders }
        : {})
    })
  }

  /** Unlike coarse repoId-only changes, lifecycle events name the workspace; removals resolve only id/path before teardown. */
  onWorktreeLifecycle(listener: (event: RuntimeWorktreeLifecycleEvent) => void): () => void {
    return this.worktreeLifecycleEvents.on(listener)
  }

  protected emitWorktreeLifecycle(event: RuntimeWorktreeLifecycleEvent): void {
    this.worktreeLifecycleEvents.emit(event)
  }

  protected notifyReposChanged(): void {
    this.pruneUnregisteredWorktreeScans()
    wakeFolderRepoGitUpgradeWatch()
    this.notifier?.reposChanged()
    this.emitClientEvent({ type: 'reposChanged' })
  }

  // Automation/IPC writes need a public stream entry; older clients drop this unknown event without negotiation.
  notifyAutomationsChanged(payload: AutomationsChangedPayload = {}): void {
    this.notifier?.automationsChanged?.(payload)
    this.emitClientEvent({ type: 'automationsChanged', ...payload })
  }
}
