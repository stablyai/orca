import { OrchestrationStructuredMailboxPointerDelivery } from '../orchestration/structured-mailbox-pointer-delivery'

import { createStructuredMailboxPointerHost } from '../orchestration/structured-mailbox-pointer-host'
import { localOrchestrationCliCommand } from '../orchestration/cli-command'
import { RuntimeOrchestrationSenderNames } from '../runtime-orchestration-sender-names'
import { isStructuredWorkerHandle } from '../../../shared/structured-worker-handle'
import { ORCA_SESSION_ADDRESS_PREFIX } from '../../../shared/orca-session-address'
import { resolveStructuredWorkerAuthority } from '../structured-worker-authority'
import { OrcaRuntimeWithRuntimeId } from './runtime-identity-state'
import { RuntimeTerminalAgentPresence } from '../runtime-terminal-agent-presence'
import type { RuntimeNotifier } from '../runtime-notifier-contract'
import { RuntimeClientEventBus } from '../runtime-client-event-bus'
import { RuntimeNativeChatDraftResolutions } from '../runtime-native-chat-draft-resolutions'
import { RuntimeWorktreeLifecycleEvents } from '../runtime-worktree-lifecycle-events'
import type {
  RuntimeWorktreeLifecycleEvent,
  RuntimeWorktreeScanCache,
  RuntimeWorktreeScanInFlight
} from '../orca-runtime-core'
import type { AgentBrowserBridge } from '../../browser/agent-browser-bridge'
import type { BrowserBackend } from '../../browser/browser-backend'
import type { EmulatorBridge } from '../../emulator/emulator-bridge'
import { RuntimeResolvedWorktreeCache } from '../runtime-resolved-worktree-cache'
import { RuntimeWorktreeLineageController } from '../runtime-worktree-lineage-controller'
import { RuntimeAgentOrchestrationProjection } from '../runtime-agent-orchestration-projection'
import { RuntimeTerminalList } from '../runtime-terminal-list'
import { RuntimeManagedWorktreeQueries } from '../runtime-managed-worktree-queries'
import { RuntimePtyForegroundAgent } from '../runtime-pty-foreground-agent'
import { OpenCodeRunLifetimeStatus } from '../opencode-run-lifetime-status'
import { readLocalPtyForegroundCommandLine } from '../local-pty-foreground-command-line'
import { isAgentStatusHooksEnabledForAgent } from '../../../shared/agent-status-hooks-setting'
import { RuntimeTerminalAgentStatusQuery } from '../runtime-terminal-agent-status-query'
import type { OrchestrationDb } from '../orchestration/db'
import { OrchestrationMailboxOwner } from '../orchestration/mailbox-owner'
import { OrchestrationMailboxDeliveryTarget } from '../orchestration/mailbox-delivery-target'
import { OrchestrationMailboxPointerDelivery } from '../orchestration/mailbox-pointer-delivery'
import { OrchestrationMailboxNotificationCoordinator } from '../orchestration/mailbox-notification-coordinator'
import type { RuntimeMessageWaiter } from '../runtime-message-waiters'
import { RuntimeMessageWaiters } from '../runtime-message-waiters'
import type { RuntimeSkillCommands } from '../runtime-skill-command-surface'
import { RuntimeTerminalStreamConsumers } from '../runtime-terminal-stream-consumers'
import type { RecentPtyOutputBuffer } from '../recent-pty-output-buffer'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { mainListsEveryPane } from '../terminal/surface/main-terminal-surfaces'
import { TUI_IDLE_QUIESCENCE_MS } from '../orca-runtime-postlude'
import { screenClearsBlockedTail } from '../blocked-tail-screen-clear'

export abstract class OrcaRuntimeWithStopRequestedPtyIds extends OrcaRuntimeWithRuntimeId {
  protected readonly stopRequestedPtyIds = new Set<string>()

  protected readonly ptyExitListenersByPtyId = new Map<string, Set<() => void>>()

  protected readonly terminalAgentPresence = new RuntimeTerminalAgentPresence({
    isLiveStructuredAgent: (handle) =>
      Boolean(resolveStructuredWorkerAuthority(handle, this._orchestrationDb)),
    getLivePty: (handle) => this.getLivePtyForHandle(handle)?.pty ?? null,
    getLiveLeaf: (handle) => this.getLiveLeafForHandle(handle).leaf,
    getPrimaryLeaf: (ptyId) => this.getLeavesForPty(ptyId)[0] ?? null,
    getTrackedPty: (ptyId) => this.ptysById.get(ptyId) ?? null,
    getTabTitle: (tabId) => this.tabs.get(tabId)?.title?.trim() || null,
    getForegroundProcess: (ptyId) => this.ptyController?.getForegroundProcess(ptyId) ?? null,
    getTitleDisplayClear: (ptyId) => this.getPtyTitleDisplayClear(ptyId)
  })

  protected notifier: RuntimeNotifier | null = null

  protected readonly clientEvents = new RuntimeClientEventBus({
    makeTitleGateKey: (rawTitle, normalizedTitle) =>
      this.makeDecorativeTitleGateKey(rawTitle, normalizedTitle),
    onConsumerAvailabilityChanged: () => this.refreshTerminalSideEffectConsumerAvailability()
  })

  protected readonly nativeChatDraftResolutions = new RuntimeNativeChatDraftResolutions({
    resolveOwner: (handle) => this.resolveNativeChatLaunchDraftOwner(handle),
    listMobileSnapshots: () => this.mobileSessionTabsByWorktree,
    setMobileSnapshot: (worktreeId, snapshot) =>
      this.storeMobileSessionSnapshot(worktreeId, snapshot),
    scheduleMobileSnapshot: (worktreeId) => this.scheduleMobileSessionTabsChanged(worktreeId),
    notifyResolved: (tabId, resolution, event) => {
      this.notifier?.nativeChatLaunchDraftResolved?.(tabId, resolution)
      this.emitClientEvent(event)
    }
  })

  protected readonly worktreeLifecycleEvents =
    new RuntimeWorktreeLifecycleEvents<RuntimeWorktreeLifecycleEvent>()

  protected agentBrowserBridge: AgentBrowserBridge | null = null

  protected offscreenBrowserBackend: BrowserBackend | null = null

  protected emulatorBridge: EmulatorBridge | null = null

  protected readonly resolvedWorktrees = new RuntimeResolvedWorktreeCache()

  protected worktreeScanGenerations = new Map<string, number>()

  protected worktreeScanCache = new Map<string, RuntimeWorktreeScanCache>()

  protected worktreeScanInFlight = new Map<string, RuntimeWorktreeScanInFlight>()

  /** Bound abandoned Git-admin filesystem probes to one per repo. */
  protected worktreeAdminFingerprintProbes = new Set<string>()

  protected readonly worktreeLineage = new RuntimeWorktreeLineageController({
    getStore: () => this.store,
    getDb: () => this.getOrchestrationDbIfAvailable(),
    resolveWorktree: (selector) => this.resolveWorktreeSelector(selector),
    listResolvedWorktrees: () => this.listResolvedWorktrees(),
    showTerminal: (handle) => this.showTerminal(handle)
  })

  protected readonly agentOrchestrationProjection = new RuntimeAgentOrchestrationProjection({
    getDb: () => this.getOrchestrationDbIfAvailable(),
    getLeaves: () => this.leaves.values(),
    getPtys: () => this.ptysById.values(),
    paneOf: (pty) => this.paneOfPty(pty),
    issueLeafHandle: (leaf) => this.issueHandle(leaf),
    issuePtyHandle: (pty) => this.issuePtyHandle(pty),
    makePaneKey: (leaf) => this.makeRuntimePaneKey(leaf),
    getWorktreeId: (handle) => this.getTerminalWorktreeIdForHandle(handle),
    getHandleForPaneKey: (paneKey) => this.getTerminalHandleForPaneKey(paneKey),
    getPaneKey: (handle) => this.getPaneKeyForTerminalHandle(handle),
    getDispatchAuthority: (handle) => this.getOrchestrationDispatchAuthority(handle),
    getAgentStatusSnapshot: () => this.getOrchestrationFleetAgentStatusSnapshot()
  })

  protected readonly terminalList = new RuntimeTerminalList({
    getGraphEpoch: () => (this.graphStatus === 'ready' ? this.rendererGraphEpoch : null),
    assertGraphEpoch: (epoch) => this.assertStableReadyGraph(epoch),
    getExplicitWorktreeId: (selector) => this.getExplicitSessionWorktreeIdSelector(selector),
    getResolvedCache: () => this.resolvedWorktrees.peek(),
    buildWorktreeFromId: (worktreeId) => this.buildResolvedWorktreeFromId(worktreeId),
    resolveWorktree: (selector) => this.resolveWorktreeSelector(selector),
    listKnownWorktrees: (worktreeId, target) =>
      this.listKnownResolvedWorktreesForExplicitTarget(worktreeId, target),
    getWorktreeMap: () => this.getResolvedWorktreeMap(),
    refreshPtys: (worktrees, targetId) =>
      this.refreshPtyWorktreeRecordsWithControllerInventory(worktrees, targetId),
    getPtys: () => this.ptysById.values(),
    getLeaves: () => this.leaves.values(),
    buildLeafSummary: (leaf, worktrees, livePtyIds) =>
      this.buildTerminalSummary(leaf, worktrees, livePtyIds),
    buildPtySummary: (pty, worktrees) => this.buildPtyTerminalSummary(pty, worktrees),
    getSnapshots: () => this.mobileSessionTabsByWorktree,
    getTabTitle: (tabId) => this.tabs.get(tabId)?.title ?? null,
    getTopologyRevision: (worktreeId) => this.getTerminalTopologyRevision(worktreeId),
    buildHostScope: (targetWorktreeId, terminals, worktrees, queriedHostIds) =>
      this.buildTerminalListHostScope(targetWorktreeId, terminals, worktrees, queriedHostIds),
    // Switch point: main lists every saved pane of a workspace it owns.
    ...(ORCA_LAYOUT_OWNER_IS_MAIN ? { listsEveryPane: (id) => mainListsEveryPane(this, id) } : {})
  })

  protected readonly managedWorktreeQueries = new RuntimeManagedWorktreeQueries({
    getStore: () => this.store,
    listResolved: () => this.listResolvedWorktrees(),
    resolveRepo: (selector) => this.resolveRepoSelector(selector),
    selectRepos: (selector) => this.selectReposBySelector(selector),
    scanRepo: (repo) => this.listRepoWorktreesForListing(repo),
    listKnownHostIds: () => this.listKnownExecutionHostIds()
  })

  protected readonly ptyForegroundAgent = new RuntimePtyForegroundAgent({
    getController: () => this.ptyController,
    getPty: (ptyId) => this.ptysById.get(ptyId) ?? null,
    touchSnapshot: (ptyId) => this.touchMobileSessionSnapshotsForPty(ptyId),
    finishDelayedSnapshot: (ptyId, changed) => {
      if (this.mobileSessionTabListeners.size > 0) {
        this.mobileSessionTabsAgentStatusHeartbeat.observeSemanticTitle(ptyId)
      }
      if (!changed) {
        this.touchMobileSessionSnapshotsForPty(ptyId)
      }
    }
  })

  protected readonly openCodeRunLifetime = new OpenCodeRunLifetimeStatus({
    isObservablePty: (ptyId) => {
      const pty = this.ptysById.get(ptyId)
      // SSH/WSL foregrounds belong to the host/guest, not this process.
      return !!pty && !pty.connectionId && !pty.wslDistro && !this.wslDistroByPtyId.has(ptyId)
    },
    isStatusEnabled: (agent) =>
      isAgentStatusHooksEnabledForAgent(this.store?.getSettings?.(), agent),
    readForegroundProcessName: async (ptyId) => {
      const read = await this.ptyForegroundAgent.read(ptyId)
      return read?.available ? read.process : null
    },
    readForegroundCommandLine: (ptyId, foregroundProcess) =>
      readLocalPtyForegroundCommandLine(ptyId, foregroundProcess),
    // Renderer command-finished can drop unchanged status rows; publish Done after that fact.
    publish: (ptyId, payload, yieldsToHookSince) =>
      this.runAfterPendingTerminalSideEffectFacts(ptyId, () =>
        this.emitTerminalAgentStatusEvents(
          ptyId,
          { payloads: [payload] },
          { origin: 'process', yieldsToHookSince }
        )
      ),
    now: () => Date.now()
  })

  protected readonly terminalAgentStatus = new RuntimeTerminalAgentStatusQuery({
    getController: () => this.ptyController,
    getLivePty: (handle) => this.getLivePtyForHandle(handle),
    getLiveLeaf: (handle) => this.getLiveLeafForHandle(handle),
    getPrimaryLeaf: (ptyId) => this.getPrimaryLeafForPty(ptyId),
    getTabTitle: (tabId) => this.tabs.get(tabId)?.title ?? null,
    getExplicitStatus: (handle) => this.getFreshExplicitAgentStatusForHandle(handle),
    getLifecycleStatus: (ptyId) => this.agentPromptLifecycleByPtyId.get(ptyId),
    isRunning: (handle) => this.isTerminalRunningAgent(handle),
    getTitleDisplayClear: (ptyId) => this.getPtyTitleDisplayClear(ptyId),
    flushPendingBlockedStamp: (ptyId) => this.flushPendingWaitBlockedCheck(ptyId),
    readScreenClearingBlockedTail: (ptyId, lastOutputAt) => {
      // Why quiet: a frame caught mid-paint can drop a dialog row the next chunk restores.
      // No output timestamp counts as quiet; a clear can only remove a block.
      if (lastOutputAt !== null && Date.now() - lastOutputAt < TUI_IDLE_QUIESCENCE_MS) {
        return null
      }
      const screen = this.readCaughtUpRuledScreen(ptyId)
      if (!screen || !screenClearsBlockedTail(this.getPaneAgentForTuiIdle(ptyId), screen.lines)) {
        return null
      }
      // Why drop the stamp: our own paste echo ends the quiet, and the tail must not re-block on it.
      this.clearWaitBlockedStamp(ptyId)
      return screen.lines.join('\n')
    }
  })

  protected _orchestrationDb: OrchestrationDb | null = null

  protected readonly orchestrationMailboxOwner = new OrchestrationMailboxOwner({
    getDb: () => this._orchestrationDb,
    getLeaf: (leafKey) => this.leaves.get(leafKey),
    getLeafKey: (tabId, leafId) => this.getLeafKey(tabId, leafId),
    getTerminalHandleForLeafKey: (leafKey) => this.handleByLeafKey.get(leafKey),
    getTerminalProcessIncarnation: (handle) => this.getTerminalProcessIncarnation(handle),
    onRoutedMessageTypes: (mailboxHandle, types) =>
      this.messageWaiters.notifyRouted(mailboxHandle, types),
    onForeignMailboxRouted: (mailboxHandle, messageType) =>
      this.notifyMessageArrived(mailboxHandle, messageType)
  })

  protected readonly orchestrationMailboxDeliveryTarget = new OrchestrationMailboxDeliveryTarget({
    getDb: () => this._orchestrationDb,
    getTerminalHandleForPaneKey: (paneKey) => this.getTerminalHandleForPaneKey(paneKey),
    hasTerminalHandle: (handle) => this.handles.has(handle),
    isStructuredSessionOwner: (handle) =>
      isStructuredWorkerHandle(handle) || handle.startsWith(ORCA_SESSION_ADDRESS_PREFIX),
    canProbePtyLiveness: () => Boolean(this.ptyController?.probePtyLiveness),
    controllerKnowsPtyIsLive: (ptyId) => this.controllerKnowsPtyIsLive(ptyId),
    isLeafPtyProvenAbsent: (ptyId) => this.isLeafPtyProvenAbsent(ptyId)
  })

  protected readonly orchestrationMailboxPointerDelivery = new OrchestrationMailboxPointerDelivery({
    mailboxOwner: this.orchestrationMailboxOwner,
    deliveryTarget: this.orchestrationMailboxDeliveryTarget,
    getDb: () => this._orchestrationDb,
    getLeaf: (leafKey) => this.leaves.get(leafKey),
    getLeafKey: (tabId, leafId) => this.getLeafKey(tabId, leafId),
    getLiveLeafForHandle: (handle) => this.getLiveLeafForHandle(handle).leaf,
    isAgentSettledForDelivery: (leaf) => this.checkDeliverySettledAndArmRecheck(leaf),
    isPtyAwaitingUserInput: (ptyId) => this.isPtyAwaitingUserInput(ptyId),
    getMessageWaiters: (mailboxHandle) => this.messageWaiters.get(mailboxHandle),
    getCliCommand: (terminalHandle) => this.getTerminalOrchestrationCliCommand(terminalHandle),
    getTerminalHandleForLeafKey: (leafKey) => this.handleByLeafKey.get(leafKey),
    resolveSubmitTarget: (leaf, ptyId) => this.resolveOrchestrationPointerSubmitTarget(leaf, ptyId),
    isLeafPtyProvenAbsent: (ptyId) => this.isLeafPtyProvenAbsent(ptyId),
    redriveMailbox: (mailboxHandle, reservedTypes) =>
      this.deliverPendingMessagesForHandle(mailboxHandle, reservedTypes),
    writePty: (ptyId, data) => this.writeOrchestrationPointerPty(ptyId, data)
  })

  protected readonly orchestrationStructuredMailboxPointerDelivery =
    new OrchestrationStructuredMailboxPointerDelivery<RuntimeMessageWaiter>({
      getDb: () => this._orchestrationDb,
      getMessageWaiters: (mailboxHandle) => this.messageWaiters.get(mailboxHandle),
      resolveStructuredTarget: (mailboxHandle) =>
        this.resolveStructuredMailboxTarget(mailboxHandle),
      getCliCommand: localOrchestrationCliCommand,
      senderName: (party, reportedDispatchId) =>
        this.orchestrationSenderNames.nameOf(party, reportedDispatchId),
      host: createStructuredMailboxPointerHost()
    })

  readonly orchestrationSenderNames = new RuntimeOrchestrationSenderNames({
    getDb: () => this._orchestrationDb,
    getHandleRecord: (handle) => this.handles.get(handle),
    getPtyAgents: (ptyId) => this.ptysById.get(ptyId),
    getTerminalPaneKey: (handle) => this.getTerminalPaneKey(handle),
    getWorkspaceSession: (worktreeId) => this.getWorkspaceSessionForWorktree(worktreeId),
    getGeneratedTitlesEnabled: () => this.store?.getSettings?.()?.tabAutoGenerateTitle === true,
    getAgentStatusSnapshotForPane: (paneKey) =>
      this.getAgentStatusSnapshotForPaneFn?.(paneKey) ??
      this.getAgentStatusSnapshotFn?.().filter((row) => row.paneKey === paneKey) ??
      [],
    getTrackedTitle: (ptyId) => this.getTrackedDisplayTitleForPty(ptyId)
  })

  protected readonly orchestrationMailboxNotifications =
    new OrchestrationMailboxNotificationCoordinator<RuntimeMessageWaiter>({
      mailboxOwner: this.orchestrationMailboxOwner,
      pointerDelivery: this.orchestrationMailboxPointerDelivery,
      structuredPointerDelivery: this.orchestrationStructuredMailboxPointerDelivery,
      getDb: () => this._orchestrationDb,
      getLiveLeafForHandle: (handle) => this.getLiveLeafForHandle(handle).leaf,
      getPaneKeyForHandle: (handle) => {
        const record = this.handles.get(handle)
        return record ? `${record.tabId}:${record.leafId}` : undefined
      },
      getMessageWaiters: (mailboxHandle) => this.messageWaiters.get(mailboxHandle),
      hasTerminalHandle: (handle) => this.handles.has(handle),
      deliverForHandle: (handle, reservedTypes) =>
        this.deliverPendingMessagesForHandle(handle, reservedTypes),
      notifyMessageArrived: (handle, messageType) => this.notifyMessageArrived(handle, messageType),
      resolveMessageWaiter: (waiter) => this.messageWaiters.resolveNotified(waiter)
    })

  protected readonly messageWaiters = new RuntimeMessageWaiters()

  protected readonly skillCommands!: RuntimeSkillCommands

  protected readonly terminalStreamConsumers = new RuntimeTerminalStreamConsumers()

  // Replay bounded startup bytes when draft paste subscribes after the ready marker.
  protected recentPtyOutputById = new Map<string, RecentPtyOutputBuffer>()

  protected setupCompletionTokenByPtyId = new Map<string, string>()
}
