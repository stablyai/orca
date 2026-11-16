import { AgentHookServerStateContract } from './server-state-contract'

import type { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'

import {
  createHookListenerState,
  canAdmitLegacyAgentStatusEntry,
  type HookListenerState
} from '../../../shared/agent-hook-listener/listener-state'
import {
  createHookTransportInterferenceTracker,
  describeHookTransportInterference,
  type HookTransportInterferenceReport
} from '../../../shared/agent-hook-listener/transport/agent-hook-transport-interference'
import {
  AgentStatusObservationSequencer,
  createAgentStatusAuthorityId
} from '../../../shared/agent-status/contracts/agent-status-observation'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'

import {
  createAgentStatusStore,
  type AgentStatusStore
} from '../../../shared/agent-status/store/agent-status-store'
import { AGENT_STATUS_2A_CURRENT_PRODUCER_MODE } from '../../../shared/agent-status/transport/agent-status-legacy-adapter'
import type { AgentStatusSubject } from '../../../shared/agent-status/contracts/agent-status-subject'
import type {
  AgentHookAuthorityEvidence,
  AgentPromptSentDedupeEntry,
  EnrichedAgentHookEventPayload,
  PaneKeyAliasEntry,
  PaneKeyAliasPersistenceListener,
  PaneStatusClearListener,
  ProviderSessionChangeListener,
  RetiredPaneFence,
  ServerAgentStatusListener,
  ServerStatusLineListener,
  StatusChangeListener,
  StatusDropListener,
  StatusFreshnessListener,
  StatusRowMutationListener
} from './server-types'
import { RevisionedMap } from './revisioned-map'
import { forgetAgentExit, type AgentExitEvidence } from './agent-exit-evidence'

export abstract class AgentHookServerState extends AgentHookServerStateContract {
  protected terminalPaneLifecycle: {
    ownsProcess(paneKey: string, ptyId: string, incarnationId?: string): boolean
    isStopping(paneKey: string): boolean
    isReversibleStop(ptyId: string, incarnationId?: string): boolean
    isPlaced(row: EnrichedAgentHookEventPayload): boolean | undefined
  } | null = null

  setTerminalPaneLifecycle(
    lifecycle: NonNullable<AgentHookServerState['terminalPaneLifecycle']>
  ): void {
    this.terminalPaneLifecycle = lifecycle
  }

  protected preservesStoppingDone(paneKey: string): boolean {
    const row = this.state.lastStatusByPaneKey.get(paneKey) as
      | EnrichedAgentHookEventPayload
      | undefined
    return (
      row?.payload.state === 'done' &&
      row.payload.sessionBoundary !== true &&
      row.providerSessionOnly !== true &&
      (row.paneSleep !== undefined || this.terminalPaneLifecycle?.isStopping(paneKey) === true)
    )
  }
  protected canWriteLegacyStatusRow(entry: AgentHookEventPayload): boolean {
    return canAdmitLegacyAgentStatusEntry(
      this.state,
      'main-status-update',
      entry,
      AGENT_STATUS_2A_CURRENT_PRODUCER_MODE
    )
  }

  // Lazy initialization avoids needing live crypto when the singleton module is imported.
  private canonicalStatusStoreInstance: AgentStatusStore | null = null
  protected get canonicalStatusStore(): AgentStatusStore {
    this.canonicalStatusStoreInstance ??= createAgentStatusStore({
      epoch: randomUUID(),
      mode: 'authority'
    })
    return this.canonicalStatusStoreInstance
  }
  protected readonly canonicalListingOrder = new Map<string, number>()
  /** Proven exits outlive the rows they reconcile. */
  protected tracksStatusPersistence = (): boolean => false
  protected readonly agentExitedAtByPaneKey = new RevisionedMap<string, AgentExitEvidence>(() =>
    this.tracksStatusPersistence()
  )

  /** A successor or worker attach invalidates the old agent's exit. */
  forgetAgentExit(paneKey: string): void {
    const forgotten = forgetAgentExit(this.agentExitedAtByPaneKey, paneKey)
    if (
      forgetAgentExit(this.agentExitedAtByPaneKey, this.resolvePaneKeyAlias(paneKey)) ||
      forgotten
    ) {
      this.scheduleStatusPersist()
    }
  }
  protected readonly canonicalSubjectsByPane = new Map<string, Map<string, AgentStatusSubject>>()
  private statusListingOrder = 0
  protected nextStatusListingOrder = (): number => ++this.statusListingOrder

  protected resetCanonicalStatus(): void {
    this.canonicalStatusStoreInstance = null
    this.canonicalListingOrder.clear()
    this.canonicalSubjectsByPane.clear()
  }
  protected server: ReturnType<typeof createServer> | null = null
  protected port = 0
  protected token = ''
  // Detect cross-talk between dev and packaged hook endpoints.
  protected env = 'production'
  protected onAgentStatus: ServerAgentStatusListener = null
  protected onClaudeStatusLine: ServerStatusLineListener = null
  protected onStartupPromptClaim: ((body: unknown) => boolean | 'pending') | null = null
  protected clearStartupPromptClaims: (() => void) | null = null
  protected statusHooksEnabled = true
  protected statusHookGeneration = 0
  protected onPaneStatusCleared: PaneStatusClearListener | null = null
  protected paneStatusClearListeners = new Set<PaneStatusClearListener>()
  protected statusDropListeners = new Set<StatusDropListener>()
  protected statusChangeListeners = new Set<StatusChangeListener>()
  protected statusFreshnessListeners = new Set<StatusFreshnessListener>()
  protected providerSessionChangeListeners = new Set<ProviderSessionChangeListener>()
  protected statusRowMutationListeners = new Set<StatusRowMutationListener>()
  // Hydration and spool replay belong to the owner lifetime, not each transport bind attempt.
  protected ownerStateInitialized = false
  // Runtime handles survive pane remints; this in-memory index owns no rows.
  protected paneKeyByTerminalHandle = new Map<string, string>()
  // Additive subscribers survive window teardown and work under headless serve.
  protected enrichedStatusListeners = new Set<(payload: EnrichedAgentHookEventPayload) => void>()
  // start() supplies paths so the hook server has no Electron dependency.
  protected endpointDir: string | null = null
  protected endpointFilePathCache: string | null = null
  protected endpointFileWritten = false
  protected state: HookListenerState = createHookListenerState({
    nextListingOrder: this.nextStatusListingOrder,
    isCanonicalPaneKey: (paneKey) => this.canonicalSubjectsByPane.has(paneKey),
    ...this.legacyRowHooks,
    onMutation: (key, before, after) => {
      if (this.tracksStatusPersistence()) {
        this.statusPersistDirtyKeys.add(key)
        if (!after) {
          this.statusPersistRemovedKeys.add(key)
        }
      }
      if (before?.launchToken !== after?.launchToken) {
        this.statusAuthorityRevision++
      }
    }
  })
  protected readonly statusPersistDirtyKeys = new Set<string>()
  protected readonly statusPersistRemovedKeys = new Set<string>()
  protected statusAuthorityRevision = 0
  protected get legacyRowHooks(): Parameters<typeof createHookListenerState>[0] {
    return {}
  }
  protected onTransportInterference: ((report: HookTransportInterferenceReport) => void) | null =
    null
  protected transportInterference = createHookTransportInterferenceTracker(
    (report: HookTransportInterferenceReport) => {
      console.warn(describeHookTransportInterference(report))
      this.onTransportInterference?.(report)
    }
  )
  // Hydrated work is UI continuity, not current-runtime liveness evidence.
  protected runtimeObservedStatusPaneKeys = new Set<string>()
  protected hydratedAuthorityCommitments: readonly AgentHookAuthorityEvidence[] = Object.freeze([])
  // Authority revisions bypass throttling to preserve replay fencing after a crash.
  protected hydratedLaunchTokenHashByPaneKey = new RevisionedMap<string, string>(() =>
    this.tracksStatusPersistence()
  )
  protected persistedAuthorityCommitmentsByPaneKey = new RevisionedMap<
    string,
    AgentHookAuthorityEvidence
  >(() => this.tracksStatusPersistence())
  protected revokedHydratedAuthorityCommitments = new WeakSet<AgentHookAuthorityEvidence>()
  protected currentAuthorityObservations = new Map<string, AgentHookAuthorityEvidence>()
  protected legacyPaneKeyAliases = new Map<string, PaneKeyAliasEntry>()
  // Index every retired alias so reattachment finds the full fence; eviction falls back to single-key lifting.
  protected retiredPaneFencesByKey = new Map<string, RetiredPaneFence>()
  protected paneKeyAliasPersistenceListener: PaneKeyAliasPersistenceListener | null = null
  // Without userDataPath, persistence is disabled and replay remains in memory.
  protected lastStatusFilePath: string | null = null
  protected statusPersistTimer: ReturnType<typeof setTimeout> | null = null
  protected statusPersistDueAt = 0
  protected lastStatusPersistStartedAt = Number.NEGATIVE_INFINITY
  protected lastPersistedAuthorityFingerprint: string | null = null
  protected assistantMessageRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  protected promptSentDedupeByPaneKey = new Map<string, AgentPromptSentDedupeEntry>()
  protected activeHookTurnCompletedAtByPaneKey = new Map<string, number>()
  protected promptSentHashSalt = randomBytes(16).toString('hex')
  protected closedAgentStatusTabIds = new Set<string>()
  protected closedAgentStatusPaneKeys = new Set<string>()
  protected restartedStatusLaunchTokenHashByPaneKey = new Map<
    string,
    { hash: string; allowRetainedOwner?: true }
  >()
  protected connectionTimestampWatermarkById = new Map<string, number>()
  // Transport clears remove rows, but replay must retain evidence age rather than renew it.
  protected evidenceObservedAtByPaneKey = new Map<string, number>()
  // Main sequences HTTP, relay and OSC observations for local, WSL and SSH panes.
  protected readonly observations = new AgentStatusObservationSequencer(
    createAgentStatusAuthorityId('main-agent-hooks')
  )
}
