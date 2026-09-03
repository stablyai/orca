// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithRuntimeId } from './orca-runtime-runtime-id'
import { RuntimeTerminalAgentPresence } from './runtime-terminal-agent-presence'
import type { RuntimeNotifier } from './runtime-notifier-contract'
import { RuntimeClientEventBus } from './runtime-client-event-bus'
import { RuntimeNativeChatDraftResolutions } from './runtime-native-chat-draft-resolutions'
import { RuntimeWorktreeLifecycleEvents } from './runtime-worktree-lifecycle-events'
import type {
  RuntimeWorktreeLifecycleEvent,
  RuntimeWorktreeScanCache,
  RuntimeWorktreeScanInFlight
} from './orca-runtime-core'
import type { AgentBrowserBridge } from '../browser/agent-browser-bridge'
import type { BrowserBackend } from '../browser/browser-backend'
import type { EmulatorBridge } from '../emulator/emulator-bridge'
import { RuntimeResolvedWorktreeCache } from './runtime-resolved-worktree-cache'
import { RuntimeWorktreeLineageController } from './runtime-worktree-lineage-controller'
import { RuntimeAgentOrchestrationProjection } from './runtime-agent-orchestration-projection'
import { RuntimeTerminalList } from './runtime-terminal-list'
import { RuntimeManagedWorktreeQueries } from './runtime-managed-worktree-queries'
import { RuntimePtyForegroundAgent } from './runtime-pty-foreground-agent'
import { RuntimeTerminalAgentStatusQuery } from './runtime-terminal-agent-status-query'
import type { OrchestrationDb } from './orchestration/db'
import { OrchestrationMailboxOwner } from './orchestration/mailbox-owner'
import { OrchestrationMailboxDeliveryTarget } from './orchestration/mailbox-delivery-target'
import { OrchestrationMailboxPointerDelivery } from './orchestration/mailbox-pointer-delivery'
import { OrchestrationMailboxNotificationCoordinator } from './orchestration/mailbox-notification-coordinator'
import type { RuntimeMessageWaiter } from './runtime-message-waiters'
import { RuntimeMessageWaiters } from './runtime-message-waiters'
import type { RuntimeSkillCommands } from './runtime-skill-command-surface'
import { RuntimeTerminalStreamConsumers } from './runtime-terminal-stream-consumers'
import type { RecentPtyOutputBuffer } from './recent-pty-output-buffer'

export class OrcaRuntimeWithStopRequestedPtyIds extends OrcaRuntimeWithRuntimeId {
  protected readonly stopRequestedPtyIds = new Set<string>()

  protected readonly ptyExitListenersByPtyId = new Map<string, Set<() => void>>()

  protected readonly terminalAgentPresence = new RuntimeTerminalAgentPresence({
    getLivePty: (handle) => this.getLivePtyForHandle(handle)?.pty ?? null,
    getLiveLeaf: (handle) => this.getLiveLeafForHandle(handle).leaf,
    getPrimaryLeaf: (ptyId) => this.getLeavesForPty(ptyId)[0] ?? null,
    getTrackedPty: (ptyId) => this.ptysById.get(ptyId) ?? null,
    getTabTitle: (tabId) => this.tabs.get(tabId)?.title?.trim() || null,
    getForegroundProcess: (ptyId) => this.ptyController?.getForegroundProcess(ptyId) ?? null
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

  /** Repos whose Git-admin probe has not settled yet; caps abandoned fs work at one per repo. */
  protected worktreeAdminFingerprintProbes = new Set<string>()

  protected readonly worktreeLineage = new RuntimeWorktreeLineageController({
    getStore: () => this.store,
    getCachedWorktrees: () => this.resolvedWorktrees.peek()?.worktrees ?? null,
    getDb: () => this.getOrchestrationDbIfAvailable(),
    resolveWorktree: (selector) => this.resolveWorktreeSelector(selector),
    listResolvedWorktrees: () => this.listResolvedWorktrees(),
    showTerminal: (handle) => this.showTerminal(handle)
  })

  protected readonly agentOrchestrationProjection = new RuntimeAgentOrchestrationProjection({
    getDb: () => this.getOrchestrationDbIfAvailable(),
    getLeaves: () => this.leaves.values(),
    getPtys: () => this.ptysById.values(),
    issueLeafHandle: (leaf) => this.issueHandle(leaf),
    issuePtyHandle: (pty) => this.issuePtyHandle(pty),
    makePaneKey: (leaf) => this.makeRuntimePaneKey(leaf),
    getWorktreeId: (handle) => this.getWorktreeIdForTerminalHandle(handle),
    getHandleForPaneKey: (paneKey) => this.getTerminalHandleForPaneKey(paneKey),
    getPaneKey: (handle) => this.getPaneKeyForTerminalHandle(handle),
    getDispatchAuthority: (handle) => this.getOrchestrationDispatchAuthority(handle)
  })

  protected readonly terminalList = new RuntimeTerminalList({
    getGraphEpoch: () => (this.graphStatus === 'ready' ? this.rendererGraphEpoch : null),
    assertGraphEpoch: (epoch) => this.assertStableReadyGraph(epoch),
    getExplicitWorktreeId: (selector) => this.getValidatedExplicitWorktreeIdSelector(selector),
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
      this.buildTerminalListHostScope(targetWorktreeId, terminals, worktrees, queriedHostIds)
  })

  protected readonly managedWorktreeQueries = new RuntimeManagedWorktreeQueries({
    getStore: () => this.store,
    listResolved: () => this.listResolvedWorktrees(),
    resolveRepo: (selector) => this.resolveRepoSelector(selector),
    selectRepos: (selector) => this.selectReposBySelector(selector),
    scanRepo: (repo) => this.listRepoWorktreesForResolution(repo)
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

  protected readonly terminalAgentStatus = new RuntimeTerminalAgentStatusQuery({
    getController: () => this.ptyController,
    getLivePty: (handle) => this.getLivePtyForHandle(handle),
    getLiveLeaf: (handle) => this.getLiveLeafForHandle(handle),
    getPrimaryLeaf: (ptyId) => this.getPrimaryLeafForPty(ptyId),
    getTabTitle: (tabId) => this.tabs.get(tabId)?.title ?? null,
    getExplicitStatus: (handle) => this.getFreshExplicitAgentStatusForHandle(handle),
    getLifecycleStatus: (ptyId) => this.agentPromptLifecycleByPtyId.get(ptyId),
    isRunning: (handle) => this.isTerminalRunningAgent(handle)
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
    getMessageWaiters: (mailboxHandle) => this.messageWaiters.get(mailboxHandle),
    getTabTitle: (tabId) => this.tabs.get(tabId)?.title,
    getTerminalHandleForLeafKey: (leafKey) => this.handleByLeafKey.get(leafKey),
    isLeafPtyProvenAbsent: (ptyId) => this.isLeafPtyProvenAbsent(ptyId),
    redriveMailbox: (mailboxHandle, reservedTypes) =>
      this.deliverPendingMessagesForHandle(mailboxHandle, reservedTypes),
    writePty: (ptyId, data) => this.writeOrchestrationPointerPty(ptyId, data)
  })

  protected readonly orchestrationMailboxNotifications =
    new OrchestrationMailboxNotificationCoordinator<RuntimeMessageWaiter>({
      mailboxOwner: this.orchestrationMailboxOwner,
      pointerDelivery: this.orchestrationMailboxPointerDelivery,
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

  protected readonly skillCommands: RuntimeSkillCommands

  // Why: mobile clients subscribe to terminal output via terminal.subscribe.
  // These listeners fire on every onPtyData call, enabling real-time streaming
  // without polling. Keyed by ptyId for O(1) lookup per data event.
  protected readonly terminalStreamConsumers = new RuntimeTerminalStreamConsumers()

  // Why: startup draft paste can subscribe after the agent already emitted its
  // ready marker. Keep a bounded raw buffer so fast startup output is replayed.
  protected recentPtyOutputById = new Map<string, RecentPtyOutputBuffer>()

  protected setupCompletionTokenByPtyId = new Map<string, string>()
}
