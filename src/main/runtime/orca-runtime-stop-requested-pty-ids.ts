// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import {
  TerminalMailboxSubscriptions,
  type CurrentTerminalMailboxAuthority
} from './orchestration/terminal-mailbox-subscriptions'
import { resolveTerminalMailboxSubscriptionLeaf } from './orchestration/terminal-mailbox-subscription-target'
import type { OrchestrationCompatibilityEvidence } from '../../shared/orchestration-compatibility-evidence'
import { OrchestrationStructuredMailboxPointerDelivery } from './orchestration/structured-mailbox-pointer-delivery'
import { createStructuredMailboxPointerHost } from './orchestration/structured-mailbox-pointer-host'
import { localOrchestrationCliCommand } from './orchestration/cli-command'
import { RuntimeOrchestrationSenderNames } from './runtime-orchestration-sender-names'
import { isStructuredWorkerHandle } from './structured-worker-identity'
import { ORCA_SESSION_ADDRESS_PREFIX } from '../../shared/orca-session-address'
import { resolveStructuredWorkerAuthority } from './structured-worker-authority'
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
import { OpenCodeRunLifetimeStatus } from './opencode-run-lifetime-status'
import { readLocalPtyForegroundCommandLine } from './local-pty-foreground-command-line'
import { isAgentStatusHooksEnabledForAgent } from '../../shared/agent-status-hooks-setting'
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
    getWorktreeId: (handle) => this.getTerminalWorktreeIdForHandle(handle),
    getHandleForPaneKey: (paneKey) => this.getTerminalHandleForPaneKey(paneKey),
    getPaneKey: (handle) => this.getPaneKeyForTerminalHandle(handle),
    getDispatchAuthority: (handle) => this.getOrchestrationDispatchAuthority(handle),
    getAgentStatusSnapshot: () => this.getOrchestrationFleetAgentStatusSnapshot()
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
      // Why: SSH and WSL foregrounds live on another host or in the guest.
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
    // Why after the chunk's facts: the renderer drops an exited agent's row on command-finished
    // unless the row changed after it, so the run's Done must arrive after that fact.
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
    getTitleDisplayClear: (ptyId) => this.getPtyTitleDisplayClear(ptyId)
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

  protected readonly terminalMailboxSubscriptions = new TerminalMailboxSubscriptions((handle) => {
    const current = this.getOrchestrationDispatchAuthority(handle)
    return current?.paneKey && current.processIncarnation
      ? {
          hostScope: current.hostScope,
          terminalHandle: current.terminalHandle,
          paneKey: current.paneKey,
          ptyId: current.ptyId,
          processIncarnation: current.processIncarnation
        }
      : null
  })

  getTerminalMailboxSubscriptionBinding(
    evidence: OrchestrationCompatibilityEvidence | undefined
  ): CurrentTerminalMailboxAuthority {
    const authority = this.verifyOrchestrationCompatibilityCaller(evidence, {
      currentRuntimeLaunchSufficient: true
    })
    if (!authority) {
      throw new Error('A verified current terminal launch is required for mailbox subscription.')
    }
    const current = this.getOrchestrationDispatchAuthority(authority.terminalHandle)
    if (
      !current?.paneKey ||
      !current.processIncarnation ||
      current.paneKey !== authority.paneKey ||
      current.processIncarnation !== authority.processIncarnation ||
      !this.orchestrationCompatibilityHostScopesEqual(current.hostScope, authority.hostScope)
    ) {
      throw new Error('The attested terminal identity changed before mailbox subscription access.')
    }
    return {
      hostScope: current.hostScope,
      terminalHandle: authority.terminalHandle,
      paneKey: current.paneKey,
      ptyId: current.ptyId,
      processIncarnation: current.processIncarnation
    }
  }

  protected resolveTerminalMailboxSubscriptionTarget(
    handle: string,
    binding = this.terminalMailboxSubscriptions.binding(handle)
  ) {
    if (!binding) {
      return null
    }
    const leaf = resolveTerminalMailboxSubscriptionLeaf({
      binding,
      current: this.getOrchestrationDispatchAuthority(handle),
      ptys: this.ptysById.values(),
      leaves: this.leaves.values(),
      handleForPty: (ptyId) => this.handleByPtyId.get(ptyId),
      handleForLeaf: (tabId, leafId) => this.handleByLeafKey.get(this.getLeafKey(tabId, leafId))
    })
    return leaf?.ptyId ? this.resolveOrchestrationPointerSubmitTarget(leaf, leaf.ptyId) : null
  }

  terminalMailboxSubscription(
    action: 'subscribe' | 'unsubscribe' | 'status',
    evidence: OrchestrationCompatibilityEvidence | undefined
  ) {
    const currentBinding = this.getTerminalMailboxSubscriptionBinding(evidence)
    const handle = currentBinding.terminalHandle
    if (
      action !== 'subscribe' &&
      !this.terminalMailboxSubscriptions.canManage(handle, currentBinding)
    ) {
      throw new Error('Mailbox subscription state belongs to a different terminal identity.')
    }
    if (action === 'unsubscribe') {
      this.terminalMailboxSubscriptions.remove(handle)
    }
    if (action === 'subscribe') {
      const target = this.resolveTerminalMailboxSubscriptionTarget(handle, currentBinding)
      if (target && target.leaf.ptyId !== currentBinding.ptyId) {
        throw new Error('The attested terminal identity changed before subscription registration.')
      }
      if (
        !target ||
        this.orchestrationMailboxOwner.resolve(target.leaf, undefined, {
          terminalHandle: handle
        }) !== handle
      ) {
        throw new Error('Mailbox subscriptions require a live bare terminal mailbox.')
      }
      this.terminalMailboxSubscriptions.register(target, {
        ...currentBinding,
        createdAt: new Date().toISOString()
      })
      this.deliverPendingMessagesForHandle(handle)
    }
    return this.terminalMailboxSubscriptions.status(handle)
  }

  protected readonly orchestrationMailboxPointerDelivery = new OrchestrationMailboxPointerDelivery({
    terminalSubscriptions: this.terminalMailboxSubscriptions,
    resolveSubscriptionTarget: (handle) => this.resolveTerminalMailboxSubscriptionTarget(handle),
    mailboxOwner: this.orchestrationMailboxOwner,
    deliveryTarget: this.orchestrationMailboxDeliveryTarget,
    getDb: () => this._orchestrationDb,
    getLeaf: (leafKey) => this.leaves.get(leafKey),
    getLeafKey: (tabId, leafId) => this.getLeafKey(tabId, leafId),
    getLiveLeafForHandle: (handle) => this.getLiveLeafForHandle(handle).leaf,
    isAgentSettledForDelivery: (leaf) => this.checkDeliverySettledAndArmRecheck(leaf),
    getMessageWaiters: (mailboxHandle) => this.messageWaiters.get(mailboxHandle),
    getTabTitle: (tabId) => this.tabs.get(tabId)?.title,
    getCliCommand: (terminalHandle) => this.getTerminalOrchestrationCliCommand(terminalHandle),
    getTerminalHandleForLeafKey: (leafKey) => this.handleByLeafKey.get(leafKey),
    resolveSubmitTarget: (leaf, ptyId, mailboxHandle) => {
      const handle = this.terminalMailboxSubscriptions.handleForPane(`${leaf.tabId}:${leaf.leafId}`)
      return handle && mailboxHandle === handle
        ? this.resolveTerminalMailboxSubscriptionTarget(handle)
        : this.resolveOrchestrationPointerSubmitTarget(leaf, ptyId)
    },
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

  /** What Orca calls an agent that sends through it; public for every such send site. */
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
