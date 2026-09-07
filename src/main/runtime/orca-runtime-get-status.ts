import { OrcaRuntimeWithGetRuntimeId } from './orca-runtime-get-runtime-id'
import type { RuntimeDegradation, RuntimeStatus } from '../../shared/runtime-types'
import {
  runtimeBrowserCommandsFactoryIsHeadless,
  runtimeBrowserUnavailableCause
} from './runtime-browser-commands-factory'
import type { RuntimeCapability } from '../../shared/protocol-version'
import {
  BROWSER_CERTIFICATE_TRUST_RUNTIME_CAPABILITY,
  BROWSER_HEADLESS_RUNTIME_CAPABILITY,
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY,
  RUNTIME_CAPABILITIES,
  RUNTIME_PROTOCOL_VERSION,
  SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY,
  TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY
} from '../../shared/protocol-version'
import {
  BROWSER_UNAVAILABLE_ERROR_CODE,
  browserUnavailableMessage
} from '../../shared/runtime-types'
import { runtimeTerminalDegradation } from './native-terminal-availability'
import type { RuntimeWorktreeLifecycleEvent } from './orca-runtime-core'
import { WORKTREE_CREATE_RESULT_TTL_MS } from './orca-runtime-core'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import type { RuntimeNotifier } from './runtime-notifier-contract'
import type {
  AutomationsChangedPayload,
  RuntimeClientEvent
} from '../../shared/runtime-client-events'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { wakeFolderRepoGitUpgradeWatch } from '../ipc/folder-repo-git-upgrade-wake'

type RuntimeStatusHost = {
  getAvailableAuthoritativeWindow(): unknown
  getRecordedTerminalSleepHandles(
    ptyIds: Iterable<string>,
    terminalHandlesByPtyId: Readonly<Record<string, readonly string[]>>
  ): string[]
}

export class OrcaRuntimeWithGetStatus extends OrcaRuntimeWithGetRuntimeId {
  private asRuntimeStatusHost(): RuntimeStatusHost {
    return this as unknown as RuntimeStatusHost
  }

  getStatus(): RuntimeStatus {
    // Why: browser panes need a backend that can create and stream a page. A
    // desktop renderer provides one via <webview>; a headless serve provides one
    // via the offscreen backend. Either way the same browser.screencast.v1 path
    // works, so advertise it when either is present. browser.headless.v1
    // additionally tells clients this host owns browser pages with no renderer,
    // so they must not fall back to a local desktop browser tab.
    const statusHost = this.asRuntimeStatusHost()
    const hasRenderer = Boolean(statusHost.getAvailableAuthoritativeWindow())
    const hasOffscreen = !hasRenderer && Boolean(this.offscreenBrowserBackend)
    const hasHeadlessCommands = runtimeBrowserCommandsFactoryIsHeadless()
    const canBrowse = hasRenderer || hasOffscreen
    const capabilities: RuntimeCapability[] = RUNTIME_CAPABILITIES.filter(
      (capability) =>
        (capability !== 'browser.screencast.v1' || canBrowse) &&
        // Why: the nested-runtime E2E needs a real legacy transport without maintaining an old binary fixture.
        (process.env.ORCA_E2E_DISABLE_RUNTIME_SHARED_CONTROL !== '1' ||
          capability !== REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY) &&
        (process.env.ORCA_E2E_DISABLE_PAIRED_TERMINAL_PARKING !== '1' ||
          capability !== TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY) &&
        (process.env.ORCA_E2E_DISABLE_AUTHORITATIVE_SESSION_TABS_INVENTORY !== '1' ||
          capability !== SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY)
    )
    if (hasOffscreen || hasHeadlessCommands) {
      capabilities.push(BROWSER_HEADLESS_RUNTIME_CAPABILITY)
    }
    // Why: certificate proceed is owned by the browser-hosting process for both
    // desktop webviews and offscreen pages. Advertise whenever either backend
    // can host a page so remote clients can surface Proceed Anyway (Unsafe).
    if (canBrowse) {
      capabilities.push(BROWSER_CERTIFICATE_TRUST_RUNTIME_CAPABILITY)
    }
    // Why the cause and not one fixed sentence: the operator can only act on the reason
    // that actually applies, and a host that says "set ORCA_BROWSER_EXECUTABLE" to someone
    // who already set it sends them to fix a thing that is not broken.
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
      // Why: headless orca serve cannot create/stream BrowserViews, so clients
      // must not treat browser panes as supported just because runtime RPC is up.
      capabilities,
      ...(degradations.length > 0 ? { degradations } : {}),
      worktreeCreateIdempotency: { dedupeTtlMs: WORKTREE_CREATE_RESULT_TTL_MS },
      hostPlatform: process.platform,
      terminalWindowsShell: this.store?.getSettings?.().terminalWindowsShell ?? null,
      floatingWorkspaceEnabled: this.store?.getSettings?.().floatingTerminalEnabled !== false,
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleMobileVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
    }
  }

  setPtyController(controller: RuntimePtyController | null): void {
    // Why: CLI terminal writes must go through the main-owned PTY registry
    // instead of tunneling back through renderer IPC, or live handles could
    // drift from the process they are supposed to control during reloads.
    this.ptyController = controller
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
    const sleepStates = [...this.terminalSleepStateByWorktreeId.values()].sort((a, b) =>
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
    const tabId =
      pty?.tabId && !pty.tabId.startsWith('pty:')
        ? pty.tabId
        : parsePaneKey(pty?.paneKey ?? '')?.tabId
    if (!pty || !tabId || tabId.startsWith('pty:')) {
      return null
    }
    return { tabId, worktreeId: pty.worktreeId }
  }

  protected notifyWorktreesChanged(repoId: string): void {
    this.notifier?.worktreesChanged(repoId)
    this.emitClientEvent({ type: 'worktreesChanged', repoId })
  }

  /** Detail-level worktree lifecycle tap (plugin event bus). The coarse
   *  worktreesChanged client event carries only repoId, which is not enough
   *  for subscribers that need the affected worktree's identity.
   *  Removal payloads carry no branch: the removal target resolves before
   *  the git worktree is torn down and only pins id + path. */
  onWorktreeLifecycle(listener: (event: RuntimeWorktreeLifecycleEvent) => void): () => void {
    return this.worktreeLifecycleEvents.on(listener)
  }

  protected emitWorktreeLifecycle(event: RuntimeWorktreeLifecycleEvent): void {
    this.worktreeLifecycleEvents.emit(event)
  }

  protected notifyReposChanged(): void {
    wakeFolderRepoGitUpgradeWatch()
    this.notifier?.reposChanged()
    this.emitClientEvent({ type: 'reposChanged' })
  }

  // Why: automation writes land in the automation service and IPC handlers, so
  // like SSH state they need a public entry point onto the client-event stream.
  // Old clients drop the unknown event type; nothing is negotiated for it.
  notifyAutomationsChanged(payload: AutomationsChangedPayload = {}): void {
    this.notifier?.automationsChanged?.(payload)
    this.emitClientEvent({ type: 'automationsChanged', ...payload })
  }
}
