// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { randomUUID } from 'node:crypto'
import type { RuntimeStore } from './runtime-store-contract'
import type { RuntimeClientSettingsController } from './runtime-client-settings'
import type { RuntimeAutomationController } from './runtime-automation-controller'
import { RuntimeArtifactController } from './runtime-artifact-controller'
import type { OrchestrationEnvironmentTransport } from './orchestration/environment-transport'
import type { RuntimeOrchestrationFederation } from './runtime-orchestration-federation'
import type {
  RuntimeGraphStatus,
  RuntimeMobileSessionCreateTerminalResult,
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeSyncedTab,
  RuntimeTerminalFocus,
  RuntimeTerminalResolvePane,
  RuntimeWorktreeTerminalSleepResult
} from '../../shared/runtime-types'
import {
  RUNTIME_GRAPH_RELOAD_TIMEOUT_MS,
  RuntimeGraphReloadLifecycle
} from './runtime-graph-reload-lifecycle'
import { RendererPublicationThrottle } from '../window/renderer-publication-throttle'
import { ClientHostedPageReconciliationWindow } from './client-hosted-page-reconciliation-window'
import { ClientSessionTabSelectionStore } from './client-session-tab-selection'
import { WorktreeTerminalMutationLock } from './worktree-terminal-mutation-lock'
import { RemoteRuntimeTerminalCreateIdempotency } from './remote-runtime-terminal-create-idempotency'
import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import type { MobileSessionTabsNotifyCoalescer } from './mobile-session-tabs-notify-coalescer'
import { createMobileSessionTabsNotifyCoalescer } from './mobile-session-tabs-notify-coalescer'
import type { MobileSessionTabsAgentStatusHeartbeat } from './mobile-session-tabs-agent-status-heartbeat'
import { createMobileSessionTabsAgentStatusHeartbeat } from './mobile-session-tabs-agent-status-heartbeat'
import { TerminalFocusNavigationCoalescer } from './terminal-focus-navigation-coalescer'
import type {
  PtyControllerInventory,
  RuntimePtyController
} from './runtime-pty-controller-contract'
import type { RuntimeLeafRecord } from './runtime-terminal-state-records'
import type { TerminalHandleRecord } from './runtime-terminal-contracts'
import type { PtyIncarnationHandleRecord } from './orca-runtime-core'
import { MailPointerRepointScheduler } from './orchestration/mail-pointer-repoint-scheduler'
import { RuntimeTerminalWaiterRegistry } from './runtime-terminal-waiter-registry'
import { RuntimeTerminalWriter } from './runtime-terminal-writer'
import { RuntimeTerminalIdlePolls } from './runtime-terminal-idle-polls'
import {
  TUI_IDLE_DEFAULT_TIMEOUT_MS,
  TUI_IDLE_POLL_INTERVAL_MS,
  TUI_IDLE_QUIESCENCE_MS
} from './orca-runtime-postlude'
import { RuntimeTerminalWait as RuntimeTerminalWaitController } from './runtime-terminal-wait'
import type { PtyLivenessVerdict } from '../../shared/pty-liveness-verdict'

export class OrcaRuntimeWithRuntimeId {
  protected readonly runtimeId = randomUUID()

  protected readonly startedAt = Date.now()

  protected readonly store: RuntimeStore | null

  protected readonly clientSettings: RuntimeClientSettingsController

  protected readonly automation: RuntimeAutomationController

  protected readonly artifacts = new RuntimeArtifactController()

  protected readonly orchestrationEnvironmentTransport: OrchestrationEnvironmentTransport | null

  protected readonly orchestrationFederation: RuntimeOrchestrationFederation

  protected rendererGraphEpoch = 0

  protected graphStatus: RuntimeGraphStatus = 'unavailable'

  protected authoritativeWindowId: number | null = null

  protected headlessGraphFallbackAvailable = false

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

  // Why: paired graph transactions need foreground timer cadence only until their publication settles.
  protected readonly rendererPublicationThrottle = new RendererPublicationThrottle()

  protected tabs = new Map<string, RuntimeSyncedTab>()

  protected mobileSessionTabsByWorktree = new Map<string, RuntimeMobileSessionTabsSnapshot>()

  /** Single host writer for mobile session snapshots; versions are total-order stamps. */
  protected storeMobileSessionSnapshot(
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot
  ): RuntimeMobileSessionTabsSnapshot {
    const existing = this.mobileSessionTabsByWorktree.get(worktreeId)
    const snapshotVersion = existing
      ? Math.max(snapshot.snapshotVersion, existing.snapshotVersion + 1)
      : snapshot.snapshotVersion
    const stamped =
      snapshotVersion === snapshot.snapshotVersion ? snapshot : { ...snapshot, snapshotVersion }
    this.mobileSessionTabsByWorktree.set(worktreeId, stamped)
    return stamped
  }

  protected structuredAgentSessionTabRestorePromise: Promise<void> | null = null

  protected structuredAgentSessionStartupRestorePromise: Promise<void> | null = null

  protected mobileSessionTabsChangeSequence = 0

  protected sessionTabsInventoryPublicationEpoch: number | null = null

  protected sessionTabsInventoryWaiters = new Set<() => void>()

  protected readonly clientHostedPageReconciliation = new ClientHostedPageReconciliationWindow(
    Date.now()
  )

  // Why: renderer publication ordering must be judged against the renderer's
  // own last-accepted (epoch, version) — never against the stored snapshot's
  // version, which main-local touches bump independently and can push
  // permanently ahead of the renderer's counter. The renderer reuses one pair
  // for byte-identical content, so a same-epoch version <= this one is a no-op
  // resend (or stale) and is skipped without touching the stored entry.
  protected acceptedRendererMobileSnapshotByWorktree = new Map<
    string,
    {
      publicationEpoch: string
      rendererVersion: number
      rendererTabCount: number
      rendererTabIdentityKeys: ReadonlySet<string>
    }
  >()

  // Why: worktree ids are path-derived and get recreated, so a renderer frame
  // that raced the delete must be rejected by the removed occupant's identity.
  // Entries are cleared once a snapshot carrying the successor's instanceId
  // is accepted; identity-less frames are fenced by renderer generation.
  protected readonly removedMobileSessionWorktreeIds = new Map<
    string,
    {
      removedPublicationEpoch?: string
      // Why: a rejected frame is still "published" on the renderer side, so a
      // later unchanged-list mention must not spiral into resync requests.
      rejectedPublication?: boolean
    }
  >()

  protected clientSessionTabSelections = new ClientSessionTabSelectionStore()

  // Why: idempotency map for mobile terminal creation — a retried create with the
  // same clientMutationId returns the in-flight operation instead of duplicating.
  protected mobileTerminalCreateByMutationId = new Map<
    string,
    Promise<RuntimeMobileSessionCreateTerminalResult>
  >()

  protected readonly terminalCreateIdempotency = new RemoteRuntimeTerminalCreateIdempotency()

  // Why: concurrent clients sleeping one host workspace must share one physical teardown.
  protected terminalSleepByWorktreeId = new Map<
    string,
    Promise<RuntimeWorktreeTerminalSleepResult>
  >()

  protected readonly terminalMutationLock = new WorktreeTerminalMutationLock()

  protected terminalSleepStateByWorktreeId = new Map<
    string,
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

  // Why: idempotency map for worktree.create — a create interrupted by a mobile
  // connection migration is retried with the same clientMutationId and returns
  // the in-flight (or just-finished) operation instead of a duplicate worktree.
  protected worktreeCreateByMutationId = new Map<string, Promise<unknown>>()

  // Why: a mobile create waits for the renderer to publish the new tab's surface
  // via graph-sync, but a throttled/hidden renderer can park that past the surface
  // timeout and the create would then destroy the live PTY (#7587). This lets the
  // renderer's own PTY spawn publish the surface main-side, scoped to in-flight
  // creates so ordinary renderer spawns never publish here.
  protected pendingMobileTerminalCreatesByKey = new Map<
    string,
    {
      activate: boolean
      paired: boolean
      selectIfNoActiveTab: boolean
      viewMode?: 'terminal' | 'chat'
      /** Resolved agent launch command, kept so a settle over a bare renderer
       *  PTY can still deliver the launch instead of succeeding silently (STA-3214). */
      startupCommand?: string
    }
  >()

  protected mobileSessionTabListeners = new Set<{
    listener: (snapshot: RuntimeMobileSessionTabsResult, changeSequence: number) => void
    clientNavigationId?: string
  }>()

  protected pendingMobileSessionTabsChangeSequenceByWorktree = new Map<string, number>()

  // Why: one watermark per repo replaces per-closed-pane fences while preserving stale-write safety.
  protected terminalTopologyRevisionByRepoId = new Map<string, number>()

  // Why: provider exit can beat surface registration; that exact dead incarnation must never publish.
  protected earlyExitedPtyIncarnations = new Map<string, PtyIncarnationId | null>()

  protected pendingPtyRegistrationIncarnations = new Map<string, PtyIncarnationId | null>()

  // Why: exact-stop is the current sleep transaction boundary; its exit must
  // leave the renderer's intentional sleeping surface available for wake.
  protected intentionalHandlelessPtyStops = new Map<string, string | null>()

  // Why: coalesces title/status-driven session.tabs emits so spinner churn
  // doesn't fan out (and per-client JSON.stringify) a snapshot several times a
  // second. Emit reads the latest snapshot, so only the freshest version ships.
  protected readonly mobileSessionTabsNotifyCoalescer: MobileSessionTabsNotifyCoalescer =
    createMobileSessionTabsNotifyCoalescer((worktreeId) =>
      this.flushScheduledMobileSessionTabsChanged(worktreeId)
    )

  protected readonly mobileSessionTabsAgentStatusHeartbeat: MobileSessionTabsAgentStatusHeartbeat =
    createMobileSessionTabsAgentStatusHeartbeat(
      (ptyId) => this.getMobileSessionWorktreeIdsForPty(ptyId),
      (worktreeId) => this.touchMobileSessionTabsForWorktree(worktreeId)
    )

  // Why: concurrent host terminal.focus storms (CLI switch fan-out / bulk open)
  // each await a full host reveal; only one terminal can be focused, so latest-wins
  // single-flight bounds host work. Does not replace cheaper activation or
  // reconnect-scan bounding for sequential soft freezes.
  protected readonly terminalFocusNavigationCoalescer =
    new TerminalFocusNavigationCoalescer<RuntimeTerminalFocus>()

  protected pendingMobileSessionPtyAggregateInventoryRefresh: Promise<PtyControllerInventory | null> | null =
    null

  protected leaves = new Map<string, RuntimeLeafRecord>()

  // Why: PTY output is a per-keystroke hot path. Looking up affected leaves by
  // ptyId keeps active TUI redraws independent of the total open terminal count.
  protected leavesByPtyId = new Map<string, RuntimeLeafRecord[]>()

  protected handles = new Map<string, TerminalHandleRecord>()

  protected handleByLeafKey = new Map<string, string>()

  protected handleByPtyId = new Map<string, string>()

  protected handleByPtyIncarnation = new Map<string, PtyIncarnationHandleRecord>()

  // A provider announces a replacement before the spawn commit can bind its
  // pane. Keep the predecessor aliases fenced during that hand-off window.
  protected pendingPtyHandleReplacementFences = new Map<
    string,
    {
      incarnationId: PtyIncarnationId
      staleHandles: Set<string>
      pendingRegistration: boolean
    }
  >()

  // Why: pointer state is process-local; one harmless replay after restart avoids a wire or schema change.
  protected readonly lastPointedMessageSequenceByHandle = new Map<string, number>()

  // Why: a waiter can reserve an older row while a newer row advances the sequence watermark.
  protected readonly pointedMessageIdsByHandle = new Map<string, Set<string>>()

  protected readonly mailPointerRepointScheduler = new MailPointerRepointScheduler((handle) =>
    this.repointPendingMessagesForHandle(handle)
  )

  protected syntheticTerminalHandles = new Set<string>()

  protected detachedPreAllocatedLeaves = new Map<string, RuntimeLeafRecord>()

  protected graphSyncCallbacks: (() => void)[] = []

  protected readonly terminalWaiters = new RuntimeTerminalWaiterRegistry()

  protected readonly terminalWriter = new RuntimeTerminalWriter(
    (ptyId, data) => this.ptyController?.write(ptyId, data) ?? false,
    (ptyId) => this.getPtyWriteHostPlatform(ptyId)
  )

  protected readonly terminalIdlePolls = new RuntimeTerminalIdlePolls({
    intervalMs: TUI_IDLE_POLL_INTERVAL_MS,
    quiescenceMs: TUI_IDLE_QUIESCENCE_MS,
    getTabTitle: (tabId) => this.tabs.get(tabId)?.title ?? null,
    getForegroundProcess: (ptyId) => this.ptyController?.getForegroundProcess(ptyId) ?? null,
    getAdoptedPtyIdleStatus: (pty) => this.getAdoptedPtyExplicitIdleStatus(pty),
    resolve: (waiter, result) => this.terminalWaiters.resolve(waiter, result)
  })

  protected readonly terminalWait = new RuntimeTerminalWaitController(
    {
      defaultTimeoutMs: TUI_IDLE_DEFAULT_TIMEOUT_MS,
      getLivePty: (handle) => this.getLivePtyForHandle(handle),
      getLiveLeaf: (handle) => this.getLiveLeafForHandle(handle),
      getAdoptedPtyIdleStatus: (pty) => this.getAdoptedPtyExplicitIdleStatus(pty),
      getTabTitle: (tabId) => this.tabs.get(tabId)?.title ?? null,
      startVisibleReadProbe: (waiter, waiterTimeoutMs) =>
        this.startTuiIdleVisibleReadProbe(waiter, waiterTimeoutMs)
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
