import type { TerminalIdentitySource } from '../terminal/identity/terminal-identity-source'
import type { SessionTitlePublisher } from '../session-tabs/session-title-publisher'
import { randomUUID } from 'node:crypto'
import { mainBindsUnendedTerminal } from '../terminal/surface/main-pane-verdict'
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import type { TerminalAgent } from '../../../shared/agent-status/identity/terminal-agent'
import { isTuiAgent } from '../../../shared/agent-launch/catalog/tui-agent-config'
import type { RuntimeStore } from './runtime-store-contract'
import type { RuntimeClientSettingsController } from '../client/settings/runtime-client-settings'
import type { RuntimeAutomationController } from '../integrations/automations/runtime-automation-controller'
import { RuntimeArtifactController } from '../artifacts/runtime-artifact-controller'
import type { OrchestrationEnvironmentTransport } from '../orchestration/federation/environment-transport'
import type { RuntimeOrchestrationFederation } from '../orchestration/federation/runtime-orchestration-federation'
import type {
  RuntimeGraphStatus,
  RuntimeMobileSessionCreateTerminalResult,
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../../shared/runtime-session-contracts'
import type {
  RuntimeTerminalFocus,
  RuntimeTerminalResolvePane,
  RuntimeWorktreeTerminalSleepResult
} from '../../../shared/runtime-terminal-contracts'
import {
  RUNTIME_GRAPH_RELOAD_TIMEOUT_MS,
  RuntimeGraphReloadLifecycle
} from '../session-graph/runtime-graph-reload-lifecycle'
import { ClientHostedPageReconciliationWindow } from '../browser/client-pages/client-hosted-page-reconciliation-window'
import { ClientSessionTabSelectionStore } from '../client/navigation/client-session-tab-selection'
import { WorktreeTerminalMutationLock } from '../workspaces/lifecycle/worktree-terminal-mutation-lock'
import { RemoteRuntimeTerminalCreateIdempotency } from '../terminal/identity/remote-runtime-terminal-create-idempotency'
import type { PtyIncarnationId } from '../../../shared/terminal/pty/lifecycle/pty-incarnation'

import type { KeyedTrailingEdgeCoalescer } from '../client/events/keyed-trailing-edge-coalescer'
import { createMobileSessionTabsNotifyCoalescer } from '../session-lifecycle/publication/mobile-session-tabs-notify-coalescer'

import type { MobileSessionTabsAgentStatusHeartbeat } from '../session-lifecycle/publication/mobile-session-tabs-agent-status-heartbeat'
import { createMobileSessionTabsAgentStatusHeartbeat } from '../session-lifecycle/publication/mobile-session-tabs-agent-status-heartbeat'
import { TerminalFocusNavigationCoalescer } from '../terminal/focus/terminal-focus-navigation-coalescer'
import type {
  PtyControllerInventory,
  RuntimePtyController
} from '../terminal/lifecycle/runtime-pty-controller-contract'
import type {
  RuntimeLeafRecord,
  PtyRegistrationClaim,
  RuntimeWorktreeTerminalSleepState
} from '../terminal/records/runtime-terminal-state-records'
import { MailPointerRepointScheduler } from '../orchestration/mailbox/notifications/mail-pointer-repoint-scheduler'
import { RuntimeTerminalWaiterRegistry } from '../terminal/wait/terminal-waiter-registry'
import { RuntimeTerminalWriter } from '../terminal/input/runtime-terminal-writer'
import { writeRefused } from '../../../shared/terminal/pty/lifecycle/pty-write-settlement'
import { RuntimeTerminalIdlePolls } from '../terminal/wait/terminal-idle-polls'
import { TerminalIntentionalStops } from '../terminal/stop/terminal-intentional-stops'
import {
  TerminalRunFactsRegister,
  type TerminalSpawnCommit
} from '../terminal/lifecycle/terminal-run-facts'
import type { TuiIdleEvidenceSource } from '../terminal/wait/tui-idle-evidence-source'
import { hasTerminalCommandPainted } from '../terminal/input/terminal-command-paint'
import {
  TUI_IDLE_DEFAULT_TIMEOUT_MS,
  TUI_IDLE_POLL_INTERVAL_MS,
  TUI_IDLE_QUIESCENCE_MS
} from '../terminal/wait/terminal-idle-policy'
import { RuntimeTerminalWait as RuntimeTerminalWaitController } from '../terminal/wait/terminal-wait'
import type { PtyLivenessVerdict } from '../../../shared/terminal/pty/lifecycle/pty-liveness-verdict'
import type { HostScopedWorktreeKey } from '../../../shared/worktree/host-qualified-identity'
import type { TerminalHandleAccess } from '../agent-senders/runtime-agent-sender-associations'

import { RuntimeConstructionServices } from './runtime-construction-services'

export type MobileSessionTabSubscription = {
  listener: (snapshot: RuntimeMobileSessionTabsResult, changeSequence: number) => void
  clientNavigationId?: string
  clientKind?: 'mobile' | 'runtime'
  observation?: 'caller'
  acceptsWorktree?: (worktree: string) => boolean
}

export abstract class OrcaRuntimeWithRuntimeId extends RuntimeConstructionServices {
  protected getLeafKey(tabId: string, leafId: string): string {
    return `${tabId}::${leafId}`
  }

  protected abstract claimIdleShellPromptForPty(ptyId: string): Promise<boolean>
  protected abstract terminalHandleAccess(): TerminalHandleAccess
  protected readonly runtimeId = randomUUID()

  protected readonly startedAt = Date.now()

  protected readonly store!: RuntimeStore | null

  protected readonly clientSettings!: RuntimeClientSettingsController

  protected readonly automation!: RuntimeAutomationController

  protected readonly artifacts = new RuntimeArtifactController()

  protected readonly orchestrationEnvironmentTransport!: OrchestrationEnvironmentTransport | null

  protected readonly orchestrationFederation!: RuntimeOrchestrationFederation

  protected abstract readonly terminalIdentity: TerminalIdentitySource
  protected abstract readonly rendererGraphEpoch: number

  protected graphStatus: RuntimeGraphStatus = 'unavailable'

  protected authoritativeWindowId: number | null = null

  protected headlessGraphFallbackAvailable = false

  /** Unlike the fallback flag, promotion never clears this: a serve host owns its graph for life. */
  protected servesHeadlessGraph = false

  protected pendingHeadlessPromotionWindowId: number | null = null

  protected rendererGeneration: string | null = null

  protected readonly graphReloadLifecycle = new RuntimeGraphReloadLifecycle({
    timeoutMs: RUNTIME_GRAPH_RELOAD_TIMEOUT_MS,
    onSettled: ({ revision, windowId, outcome, durationMs }) => {
      console.info(
        `[runtime-graph] reload revision=${revision} window=${windowId} outcome=${outcome} durationMs=${durationMs}`
      )
    },
    onTimeout: (_revision, windowId) => this.handleGraphReloadTimeout(windowId)
  })

  protected abstract readonly tabs: TerminalIdentitySource['tabs']

  protected legacyStructuredSessionTabIds: readonly string[] = []

  mobileSessionTabsByWorktree = new Map<string, RuntimeMobileSessionTabsSnapshot>()

  abstract storeMobileSessionSnapshot(
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot
  ): RuntimeMobileSessionTabsSnapshot

  protected structuredAgentSessionTabRestorePromise: Promise<void> | null = null

  protected structuredAgentSessionInventoryUnverifiable = false

  protected structuredAgentSessionStartupRestorePromise: Promise<void> | null = null

  protected mobileSessionTabsChangeSequence = 0

  protected sessionTabsInventoryPublicationEpoch: number | null = null

  protected sessionTabsInventoryWaiters = new Set<() => void>()

  // Placeholder replies owe a real snapshot after graph publication.
  protected worktreesAwaitingSessionTabsPublication = new Set<string>()

  protected readonly clientHostedPageReconciliation = new ClientHostedPageReconciliationWindow(
    Date.now()
  )

  // Main touches advance stored versions; compare renderer resends against the last accepted renderer stamp.
  protected acceptedRendererMobileSnapshotByWorktree = new Map<
    string,
    {
      publicationEpoch: string
      rendererVersion: number
      rendererTabCount: number
      rendererTabIdentityKeys: ReadonlySet<string>
      titlePublisher?: SessionTitlePublisher
    }
  >()

  // Recreated path ids need occupant fences against pre-delete renderer frames.
  // Clear on successor instance acceptance; identity-less frames remain renderer-generation-fenced.
  protected readonly removedMobileSessionWorktreeIds = new Map<
    string,
    {
      removedPublicationEpoch?: string
      // Rejected frames still count as renderer-published; suppress unchanged-list resync loops.
      rejectedPublication?: boolean
    }
  >()

  protected clientSessionTabSelections = new ClientSessionTabSelectionStore()

  // Retried mobile creates share their in-flight mutation instead of spawning twice.
  protected mobileTerminalCreateByMutationId = new Map<
    string,
    Promise<RuntimeMobileSessionCreateTerminalResult>
  >()

  protected readonly terminalCreateIdempotency = new RemoteRuntimeTerminalCreateIdempotency()

  // Concurrent clients share one teardown per host + workspace, never bare workspace id.
  protected terminalSleepByHostWorktree = new Map<
    HostScopedWorktreeKey,
    Promise<RuntimeWorktreeTerminalSleepResult>
  >()

  protected readonly terminalMutationLock = new WorktreeTerminalMutationLock()

  protected terminalSleepStateByHostWorktree = new Map<
    HostScopedWorktreeKey,
    RuntimeWorktreeTerminalSleepState
  >()

  protected terminalSleepGeneration = 0

  protected terminalPaneRecoveryByIdentity = new Map<string, Promise<RuntimeTerminalResolvePane>>()

  // Mobile connection migration retries reuse the same mutation's worktree create.
  protected worktreeCreateByMutationId = new Map<string, Promise<unknown>>()

  // #7587: hidden renderer graph-sync can time out after a live PTY spawns.
  // In-flight mobile creates let the spawn publish main-side; ordinary renderer spawns must not.
  protected pendingMobileTerminalCreatesByKey = new Map<
    string,
    {
      activate: boolean
      paired: boolean
      selectIfNoActiveTab: boolean
      viewMode?: 'terminal' | 'chat'
      /** Retain launch delivery over bare renderer PTYs; silent settlement would lose the command (STA-3214). */
      startupCommand?: string
    }
  >()

  protected mobileSessionTabListeners = new Set<MobileSessionTabSubscription>()

  protected pendingMobileSessionTabsChangeSequenceByWorktree = new Map<string, number>()

  // Per-repo watermarks replace closed-pane fences while retaining stale-write protection.
  protected terminalTopologyRevisionByRepoId = new Map<string, number>()

  // The candidate receipt owns its exit evidence until publication or cancellation.
  protected pendingPtyRegistrationIncarnations = new Map<string, PtyRegistrationClaim>()

  readonly intentionalPtyStops = new TerminalIntentionalStops()

  readonly terminalRunFacts = new TerminalRunFactsRegister()

  noteTerminalSpawnCommit(commit: TerminalSpawnCommit, expectedSourceBinding?: unknown): void {
    this.terminalRunFacts.recordSpawnCommit(commit, expectedSourceBinding)
    this.intentionalPtyStops.noteSpawnCommit(commit.id)
  }

  protected readonly mobileSessionTabsNotifyCoalescer: KeyedTrailingEdgeCoalescer =
    createMobileSessionTabsNotifyCoalescer((worktreeId) =>
      this.flushScheduledMobileSessionTabsChanged(worktreeId)
    )

  protected readonly mobileSessionTabsAgentStatusHeartbeat: MobileSessionTabsAgentStatusHeartbeat =
    createMobileSessionTabsAgentStatusHeartbeat(
      (ptyId) => this.getMobileSessionWorktreeIdsForPty(ptyId),
      (worktreeId) => this.touchMobileSessionTabsForWorktree(worktreeId)
    )

  // Concurrent focus requests share one host reveal; the latest pane wins.
  protected readonly terminalFocusNavigationCoalescer =
    new TerminalFocusNavigationCoalescer<RuntimeTerminalFocus>()

  protected pendingMobileSessionPtyAggregateInventoryRefresh: Promise<PtyControllerInventory | null> | null =
    null

  /** Rank launch authority first, then foreground evidence for agents Orca did not launch. */
  getPaneTerminalAgent(ptyId: string | null | undefined): TerminalAgent | null {
    const pty = ptyId ? this.ptysById.get(ptyId) : undefined
    return pty?.launchAgent ?? pty?.foregroundAgent ?? pty?.launchCommandAgent ?? null
  }

  protected getPaneAgentForTuiIdle(ptyId: string | null | undefined): TuiAgent | null {
    const agent = this.getPaneTerminalAgent(ptyId)
    return isTuiAgent(agent) ? agent : null
  }

  protected deliveryRecheckTimersByPtyId = new Map<string, ReturnType<typeof setTimeout>>()

  // Sequence authoritative graph statements to distinguish absent surfaces from unpublished ones.
  protected abstract readonly graphSequence: number

  protected abstract readonly leaves: TerminalIdentitySource['leaves']

  // Index per-keystroke output by PTY so redraw cost does not scale with all open terminals.
  protected leavesByPtyId = new Map<string, readonly RuntimeLeafRecord[]>()

  abstract readonly handles: TerminalIdentitySource['handles']

  protected abstract readonly handleByLeafKey: TerminalIdentitySource['leafHandles']

  protected abstract readonly handleByPtyId: TerminalIdentitySource['reverse']

  protected abstract readonly handleByPtyIncarnation: TerminalIdentitySource['incarnations']

  // Fence predecessor aliases until the announced replacement's spawn commit binds its pane.
  protected pendingPtyHandleReplacementFences = new Map<
    string,
    {
      incarnationId: PtyIncarnationId
      staleHandles: Set<string>
      pendingRegistration: boolean
    }
  >()

  protected readonly mailPointerRepointScheduler = new MailPointerRepointScheduler((handle) =>
    this.repointPendingMessagesForHandle(handle)
  )

  protected abstract readonly syntheticTerminalHandles: TerminalIdentitySource['synthetic']

  protected detachedPreAllocatedLeaves = new Map<string, RuntimeLeafRecord>()

  protected graphSyncCallbacks: (() => void)[] = []

  protected readonly terminalWaiters = new RuntimeTerminalWaiterRegistry()

  protected readonly terminalWriter = new RuntimeTerminalWriter(
    (ptyId, data, inputKind) => this.ptyController?.write(ptyId, data, inputKind) ?? false,
    (ptyId) => this.getPtyWriteHostPlatform(ptyId),
    (ptyId) => this.getPtyAgent(ptyId),
    (ptyId, data, inputKind) =>
      this.ptyController?.writeWithSettlement?.(ptyId, data, inputKind) ??
      writeRefused('provider_cannot_settle'),
    (ptyId) => this.claimIdleShellPromptForPty(ptyId)
  )

  // Every tui-idle site must rank the same pane evidence identically.
  protected readonly tuiIdleEvidenceSource: TuiIdleEvidenceSource = {
    quiescenceMs: TUI_IDLE_QUIESCENCE_MS,
    getAdoptedPtyIdleStatus: (pty) => this.getAdoptedPtyExplicitIdleStatus(pty),
    getPaneAgent: (ptyId) => this.getPaneAgentForTuiIdle(ptyId),
    getFirstPartyAgentStatus: (ptyId) =>
      (ptyId ? this.ptysById.get(ptyId)?.lastExplicitAgentStatus : null) ?? null,
    getHookTurn: (ptyId, agent) => this.readTuiIdleHookTurnForPty(ptyId, agent),
    readScreenLines: (ptyId) => this.readLiveTerminalScreenLines(ptyId),
    readRuledScreen: (ptyId) => this.readRuledScreen(ptyId),
    getOutputClockAt: (ptyId) => this.readOutputClockAt(ptyId)
  }

  protected readonly terminalIdlePolls = new RuntimeTerminalIdlePolls({
    ...this.tuiIdleEvidenceSource,
    intervalMs: TUI_IDLE_POLL_INTERVAL_MS,
    getForegroundProcess: (ptyId) => this.ptyController?.getForegroundProcess(ptyId) ?? null,
    hasCommandPainted: (ptyId) => {
      const pty = this.ptysById.get(ptyId)
      return pty === undefined || hasTerminalCommandPainted(pty)
    },
    // Runtime emulator reads avoid a provider round trip on every poll.
    readVisibleScreen: (ptyId) =>
      this.headlessTerminals.has(ptyId)
        ? this.readHeadlessVisibleTerminalState(ptyId).then(
            (screen) => screen?.lines.join('\n') ?? null
          )
        : null,
    resolve: (waiter, result) => this.terminalWaiters.resolve(waiter, result)
  })

  protected readonly terminalWait = new RuntimeTerminalWaitController(
    {
      ...this.tuiIdleEvidenceSource,
      defaultTimeoutMs: TUI_IDLE_DEFAULT_TIMEOUT_MS,
      getTerminalPty: (handle, condition) =>
        condition === 'exit'
          ? this.getExitWaitPtyForHandle(handle)
          : this.getTerminalPtyForHandle(handle),
      exitUnsettled: (pty) =>
        pty.lastExitCode === null &&
        mainBindsUnendedTerminal(this, pty.ptyId, this.ptyLivenessVerdictByPtyId.get(pty.ptyId)),
      startVisibleReadProbe: (waiter, waiterTimeoutMs, agent) =>
        this.startTuiIdleVisibleReadProbe(waiter, waiterTimeoutMs, agent)
    },
    this.terminalWaiters,
    this.terminalIdlePolls
  )

  protected ptyController: RuntimePtyController | null = null

  protected readonly ptyLivenessVerdictByPtyId = new Map<
    string,
    { verdict: PtyLivenessVerdict; observedAt: number }
  >()

  protected ptyLivenessObservationSequence = 0
}
