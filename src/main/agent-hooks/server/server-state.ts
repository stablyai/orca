import type {
  AgentProcessPresence,
  AgentProcessVerdict
} from '../../../shared/agent-process-presence'
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
} from '../../../shared/agent-hook-transport-interference'
import {
  AgentStatusObservationSequencer,
  createAgentStatusAuthorityId,
  type AgentStatusObservation,
  type AgentStatusObservationOrigin
} from '../../../shared/agent-status-observation'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import type { AgentHookSource } from '../../../shared/agent-hook-relay'
import type { AgentStatusClearIpcPayload } from '../../../shared/agent-status-types'
import type { LegacyPaneKeyAliasEntry } from '../../../shared/persisted-state-types'
import type { SpoolRecord } from '../../../shared/agent-hook-spool'
import { createAgentStatusStore, type AgentStatusStore } from '../../../shared/agent-status-store'
import { AGENT_STATUS_2A_CURRENT_PRODUCER_MODE } from '../../../shared/agent-status-legacy-adapter'
import type { AgentStatusSubject } from '../../../shared/agent-status-subject'
import type {
  AgentHookAuthorityEvidence,
  AgentHookProviderSessionIdentity,
  AgentHookStatusChangeEntry,
  AgentHookStatusFreshnessObservation,
  AgentPromptSentDedupeEntry,
  EnrichedAgentHookEventPayload,
  NormalizedLocalHook,
  PaneKeyAliasEntry,
  PaneKeyAliasPersistenceListener,
  PaneStatusClearListener,
  ProviderSessionChangeListener,
  RetiredPaneAlias,
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

export abstract class AgentHookServerState {
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
  protected readonly agentExitedAtByPaneKey = new Map<string, AgentExitEvidence>()

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
    isCanonicalPaneKey: (paneKey) => this.canonicalSubjectsByPane.has(paneKey)
  })
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
  protected hydratedLaunchTokenHashByPaneKey = new RevisionedMap<string, string>()
  protected persistedAuthorityCommitmentsByPaneKey = new RevisionedMap<
    string,
    AgentHookAuthorityEvidence
  >()
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

  protected abstract withdrawReplayObservation(paneKey: string): void
  protected abstract getTmuxSelectedStatus(
    paneKey: string
  ): EnrichedAgentHookEventPayload | undefined
  protected abstract deleteTmuxSelectedStatus(
    paneKey: string
  ): EnrichedAgentHookEventPayload | undefined
  protected abstract clearTmuxInnerSubjects(paneKey: string): void
  protected abstract clearTmuxTabSubjects(tabId: string): void
  protected abstract ingestSpoolRecord(record: SpoolRecord): Promise<void> | void
  protected abstract emitPaneStatusCleared(clear: AgentStatusClearIpcPayload): void
  protected abstract buildStatusChangeNotification(): {
    statuses: AgentHookStatusChangeEntry[]
    providerSessions: AgentHookProviderSessionIdentity[]
  }
  protected abstract notifyStatusChangeListeners(): void
  protected abstract emitStatusFreshnessObservation(
    status: AgentHookStatusFreshnessObservation
  ): void
  protected abstract markTabClosedForAgentStatus(tabId: string): void
  protected abstract getAgentStatusDisposition(
    paneKey: string,
    event?: {
      source?: AgentHookSource
      rawSource?: unknown
      hookEventName?: string
      isReplay?: boolean
      hasExplicitPrompt?: boolean
      launchToken?: string
      retainedLaunchTokenHash?: string
    }
  ): 'accept' | 'restart' | 'suppress'
  protected abstract isClosedAgentStatusTabForPaneKey(paneKey: string): boolean
  protected abstract takeRetiredPaneRestartId(paneKey: string): string | undefined
  protected abstract recordRetiredPaneFence(
    paneKeys: ReadonlySet<string>,
    aliases: readonly RetiredPaneAlias[],
    retirementId?: string
  ): void
  protected abstract markPaneClosedForAgentStatus(paneKey: string): void
  protected abstract attachStatusTiming(
    payload: AgentHookEventPayload,
    now?: number,
    observedAt?: number
  ): EnrichedAgentHookEventPayload
  protected abstract hashPromptForTelemetryDedupe(prompt: string): string
  protected abstract maybeTrackAgentPromptSent(
    payload: AgentHookEventPayload,
    previousStatus: EnrichedAgentHookEventPayload | undefined
  ): void
  protected abstract stampObservation(
    payload: AgentHookEventPayload,
    origin: AgentStatusObservationOrigin,
    observedAt: number
  ): AgentStatusObservation
  protected abstract applyNormalizedStatus(
    payload: AgentHookEventPayload,
    onAccepted?: () => void,
    origin?: AgentStatusObservationOrigin,
    observedAt?: number,
    mutationBefore?: EnrichedAgentHookEventPayload
  ): EnrichedAgentHookEventPayload | undefined
  protected abstract emitEnrichedStatus(enriched: EnrichedAgentHookEventPayload): void
  protected abstract clearAssistantMessageRetry(paneKey: string): void
  protected abstract clearTranscriptPoll(paneKey: string): void
  protected abstract clearAllTranscriptPolls(): void
  protected abstract scheduleTranscriptPoll(
    source: AgentHookSource,
    body: unknown,
    original: EnrichedAgentHookEventPayload
  ): void
  protected abstract scheduleAssistantMessageRetry(
    source: AgentHookSource,
    body: unknown,
    original: EnrichedAgentHookEventPayload,
    attempt?: number,
    discoveryReady?: boolean
  ): void
  protected abstract applyAssistantMessageRetry(
    source: AgentHookSource,
    body: unknown,
    original: EnrichedAgentHookEventPayload,
    nextAttempt: number,
    requireExactOriginal: boolean
  ): void
  protected abstract getPersistedPaneKeyAliases(): LegacyPaneKeyAliasEntry[]
  protected abstract notifyPaneKeyAliasPersistenceListener(): void
  protected abstract boundPaneKeyAliases(): void
  protected abstract getPhysicalPaneKeyForAuthority(paneKey: string, ptyId?: string): string
  protected abstract restoreRetiredPaneFence(fence: RetiredPaneFence): void
  protected abstract revokeHydratedAuthorityForPaneKeys(paneKeys: ReadonlySet<string>): boolean
  protected abstract resolvePaneKeyAlias(paneKey: string): string
  protected abstract normalizeHookBodyPaneKeyAlias(body: unknown): unknown
  protected abstract normalizeLocalHookPayload(
    source: AgentHookSource,
    body: unknown
  ): NormalizedLocalHook
  protected abstract setClaudeBackgroundEvidence(
    paneKey: string,
    hasRunningTask: boolean,
    hasActiveCron: boolean
  ): void
  protected abstract toRetainedProviderSessionRow(
    entry: EnrichedAgentHookEventPayload | null | undefined
  ): EnrichedAgentHookEventPayload | null
  protected abstract hasLiveClaimsForPaneKey(paneKey: string): boolean
  abstract checkAgentPresence(paneKey: string): Promise<AgentProcessVerdict | null>
  abstract checkAgentPresenceAfterHook(
    event: AgentHookEventPayload,
    row: AgentHookEventPayload
  ): void

  abstract reconcileEndedProcessForPaneKeys(
    paneKeys: Iterable<string>,
    options?: { preserveResumeIdentity?: boolean; endedPresence?: AgentProcessPresence }
  ): number

  protected abstract clearPaneState(
    paneKey: string,
    options?: {
      emitStatusRowMutation?: boolean
      preserveTmuxInnerSubjects?: boolean
      statusUnavailable?: true
      forgetAgentExit?: true
    }
  ): void
  protected abstract deleteStatusEntry(
    paneKey: string,
    options?: { preserveAuthority?: boolean }
  ): EnrichedAgentHookEventPayload | null
  protected abstract maybeWriteEndpointFile(): void
  protected abstract hydrateLastStatusFromDisk(): void
  protected abstract captureHydratedAuthorityCommitments(): void
  protected abstract recordCurrentAuthorityObservation(payload: AgentHookEventPayload): void
  protected abstract toAuthorityEvidence(
    payload: AgentHookEventPayload | EnrichedAgentHookEventPayload,
    launchTokenHashOverride?: string
  ): AgentHookAuthorityEvidence | null
  protected abstract serializeStatusFile(): string
  protected abstract scheduleStatusPersist(): void
  protected abstract runStatusPersist(): void
  protected abstract primeStatusPersistBaseline(onDiskJson: string): void

  abstract _getStateForTests(): HookListenerState
  abstract _resetPromptSentDedupeForTests(): void
  abstract _resetConnectionTimestampWatermarksForTests(): void
}
