import { randomUUID } from 'node:crypto'
import { preserveTerminalRetirementProofs } from '../mobile-session-terminal-retirement-proof'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { startedMainTerminalSurfaces } from '../terminal/surface/main-terminal-surfaces'
import { mainBindsUnendedTerminal } from '../terminal/surface/main-pane-verdict'
import {
  headlessMobileSnapshotContentUnchanged,
  mobileSnapshotIdentityUnchanged
} from '../mobile-session-snapshot-equality'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { TerminalAgent } from '../../../shared/terminal-agent'
import { isTuiAgent } from '../../../shared/tui-agent-config'
import type { RuntimeStore } from '../runtime-store-contract'
import type { RuntimeClientSettingsController } from '../runtime-client-settings'
import type { RuntimeAutomationController } from '../runtime-automation-controller'
import { RuntimeArtifactController } from '../runtime-artifact-controller'
import type { OrchestrationEnvironmentTransport } from '../orchestration/environment-transport'
import type { RuntimeOrchestrationFederation } from '../runtime-orchestration-federation'
import type {
  RuntimeGraphStatus,
  RuntimeMobileSessionCreateTerminalResult,
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeSyncedTab,
  RuntimeTerminalFocus,
  RuntimeTerminalResolvePane,
  RuntimeWorktreeTerminalSleepResult
} from '../../../shared/runtime-types'
import {
  RUNTIME_GRAPH_RELOAD_TIMEOUT_MS,
  RuntimeGraphReloadLifecycle
} from '../runtime-graph-reload-lifecycle'
import { ClientHostedPageReconciliationWindow } from '../client-hosted-page-reconciliation-window'
import { ClientSessionTabSelectionStore } from '../client-session-tab-selection'
import { WorktreeTerminalMutationLock } from '../worktree-terminal-mutation-lock'
import { RemoteRuntimeTerminalCreateIdempotency } from '../remote-runtime-terminal-create-idempotency'
import type { PtyIncarnationId } from '../../../shared/pty-incarnation'
import type { MobileSessionTabsNotifyCoalescer } from '../mobile-session-tabs-notify-coalescer'
import { createMobileSessionTabsNotifyCoalescer } from '../mobile-session-tabs-notify-coalescer'
import type { MobileSessionTabsAgentStatusHeartbeat } from '../mobile-session-tabs-agent-status-heartbeat'
import { createMobileSessionTabsAgentStatusHeartbeat } from '../mobile-session-tabs-agent-status-heartbeat'
import { TerminalFocusNavigationCoalescer } from '../terminal-focus-navigation-coalescer'
import type {
  PtyControllerInventory,
  RuntimePtyController
} from '../runtime-pty-controller-contract'
import type { RuntimeLeafRecord, PtyRegistrationClaim } from '../runtime-terminal-state-records'
import type { TerminalHandleRecord } from '../runtime-terminal-contracts'
import type { PtyIncarnationHandleRecord } from '../orca-runtime-core'
import { MailPointerRepointScheduler } from '../orchestration/mail-pointer-repoint-scheduler'
import { RuntimeTerminalWaiterRegistry } from '../terminal/wait/terminal-waiter-registry'
import { RuntimeTerminalWriter } from '../runtime-terminal-writer'
import { writeRefused } from '../../../shared/pty-write-settlement'
import { RuntimeTerminalIdlePolls } from '../terminal/wait/terminal-idle-polls'
import { TerminalIntentionalStops } from '../terminal-intentional-stops'
import { TerminalRunFactsRegister, type TerminalSpawnCommit } from '../terminal-run-facts'
import type { TuiIdleEvidenceSource } from '../tui-idle-evidence-source'
import { hasTerminalCommandPainted } from '../terminal-command-paint'
import {
  TUI_IDLE_DEFAULT_TIMEOUT_MS,
  TUI_IDLE_POLL_INTERVAL_MS,
  TUI_IDLE_QUIESCENCE_MS
} from '../orca-runtime-postlude'
import { RuntimeTerminalWait as RuntimeTerminalWaitController } from '../terminal/wait/terminal-wait'
import type { PtyLivenessVerdict } from '../../../shared/pty-liveness-verdict'
import type { HostScopedWorktreeKey } from '../../../shared/worktree/host-qualified-identity'

import { RuntimeConstructionServices } from './runtime-construction-services'

export abstract class OrcaRuntimeWithRuntimeId extends RuntimeConstructionServices {
  protected abstract claimIdleShellPromptForPty(ptyId: string): Promise<boolean>
  protected readonly runtimeId = randomUUID()

  protected readonly startedAt = Date.now()

  protected readonly store!: RuntimeStore | null

  protected readonly clientSettings!: RuntimeClientSettingsController

  protected readonly automation!: RuntimeAutomationController

  protected readonly artifacts = new RuntimeArtifactController()

  protected readonly orchestrationEnvironmentTransport!: OrchestrationEnvironmentTransport | null

  protected readonly orchestrationFederation!: RuntimeOrchestrationFederation

  protected rendererGraphEpoch = 0

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

  protected tabs = new Map<string, RuntimeSyncedTab>()

  protected legacyStructuredSessionTabIds: readonly string[] = []

  mobileSessionTabsByWorktree = new Map<string, RuntimeMobileSessionTabsSnapshot>()

  storeMobileSessionSnapshot(
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot
  ): RuntimeMobileSessionTabsSnapshot {
    const existing = this.mobileSessionTabsByWorktree.get(worktreeId)
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      const merged = startedMainTerminalSurfaces(this)?.withMainOrder(snapshot) ?? snapshot
      // Main-order-only rebuilds are no-ops unless occupant/publication/retirement evidence changed.
      if (
        existing &&
        mobileSnapshotIdentityUnchanged(existing, snapshot) &&
        headlessMobileSnapshotContentUnchanged(existing, merged) &&
        !headlessMobileSnapshotContentUnchanged(snapshot, merged)
      ) {
        return existing
      }
      snapshot = merged
    }
    snapshot = preserveTerminalRetirementProofs(snapshot, existing)
    const snapshotVersion = existing
      ? Math.max(snapshot.snapshotVersion, existing.snapshotVersion + 1)
      : snapshot.snapshotVersion
    const stamped =
      snapshotVersion === snapshot.snapshotVersion ? snapshot : { ...snapshot, snapshotVersion }
    this.mobileSessionTabsByWorktree.set(worktreeId, stamped)
    return stamped
  }

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
    {
      worktreeId: string
      generation: number
      phase: 'stopping' | 'partial' | 'sleeping'
      ptyIds: string[]
      terminalHandles: string[]
      terminalHandlesByPtyId: Record<string, string[]>
    }
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

  protected mobileSessionTabListeners = new Set<{
    listener: (snapshot: RuntimeMobileSessionTabsResult, changeSequence: number) => void
    clientNavigationId?: string
  }>()

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

  protected readonly mobileSessionTabsNotifyCoalescer: MobileSessionTabsNotifyCoalescer =
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
  protected getPaneTerminalAgent(ptyId: string | null | undefined): TerminalAgent | null {
    const pty = ptyId ? this.ptysById.get(ptyId) : undefined
    return pty?.launchAgent ?? pty?.foregroundAgent ?? pty?.launchCommandAgent ?? null
  }

  protected getPaneAgentForTuiIdle(ptyId: string | null | undefined): TuiAgent | null {
    const agent = this.getPaneTerminalAgent(ptyId)
    return isTuiAgent(agent) ? agent : null
  }

  protected deliveryRecheckTimersByPtyId = new Map<string, ReturnType<typeof setTimeout>>()

  // Sequence authoritative graph statements to distinguish absent surfaces from unpublished ones.
  protected graphSequence = 0

  protected leaves = new Map<string, RuntimeLeafRecord>()

  // Index per-keystroke output by PTY so redraw cost does not scale with all open terminals.
  protected leavesByPtyId = new Map<string, RuntimeLeafRecord[]>()

  handles = new Map<string, TerminalHandleRecord>()

  protected handleByLeafKey = new Map<string, string>()

  protected handleByPtyId = new Map<string, string>()

  protected handleByPtyIncarnation = new Map<string, PtyIncarnationHandleRecord>()

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

  protected syntheticTerminalHandles = new Set<string>()

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
      getTerminalPty: (handle) => this.getTerminalPtyForHandle(handle),
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
