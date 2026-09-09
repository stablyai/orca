import type { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'

import {
  createHookListenerState,
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
import type {
  AgentHookAuthorityEvidence,
  AgentHookProviderSessionIdentity,
  AgentHookStatusChangeEntry,
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
  StatusDropListener
} from './server-types'

/** Shared mutable state for the layered hook-server implementation. */
export abstract class AgentHookServerState {
  protected server: ReturnType<typeof createServer> | null = null
  protected port = 0
  protected token = ''
  // Why: identifies this Orca instance so the server can detect dev vs. prod cross-talk; set at start() from packaged-build knowledge.
  protected env = 'production'
  protected onAgentStatus: ServerAgentStatusListener = null
  protected onClaudeStatusLine: ServerStatusLineListener = null
  protected onPaneStatusCleared: PaneStatusClearListener | null = null
  protected paneStatusClearListeners = new Set<PaneStatusClearListener>()
  protected statusDropListeners = new Set<StatusDropListener>()
  protected statusChangeListeners = new Set<StatusChangeListener>()
  protected providerSessionChangeListeners = new Set<ProviderSessionChangeListener>()
  // Why: setListener is a single slot owned by the main-window fanout; the
  // plugin event bus (and future consumers) need an additive subscription
  // that also works in headless serve, where no window listener exists.
  protected enrichedStatusListeners = new Set<(payload: EnrichedAgentHookEventPayload) => void>()
  // Why: set via start()'s userDataPath so the class has no direct Electron dependency (mockable in vitest node env).
  protected endpointDir: string | null = null
  protected endpointFilePathCache: string | null = null
  protected endpointFileWritten = false
  // Why: per-instance (not module-level) so tests can spin up multiple servers without state cross-contamination.
  protected state: HookListenerState = createHookListenerState()
  protected onTransportInterference: ((report: HookTransportInterferenceReport) => void) | null =
    null
  protected transportInterference = createHookTransportInterferenceTracker(
    (report: HookTransportInterferenceReport) => {
      console.warn(describeHookTransportInterference(report))
      this.onTransportInterference?.(report)
    }
  )
  // Why: hydrated rows give UI continuity but aren't evidence of live agent work in this runtime.
  protected runtimeObservedStatusPaneKeys = new Set<string>()
  protected hydratedAuthorityCommitments: readonly AgentHookAuthorityEvidence[] = Object.freeze([])
  protected hydratedLaunchTokenHashByPaneKey = new Map<string, string>()
  protected persistedAuthorityCommitmentsByPaneKey = new Map<string, AgentHookAuthorityEvidence>()
  protected revokedHydratedAuthorityCommitments = new WeakSet<AgentHookAuthorityEvidence>()
  protected currentAuthorityObservations = new Map<string, AgentHookAuthorityEvidence>()
  protected legacyPaneKeyAliases = new Map<string, PaneKeyAliasEntry>()
  // Why: indexed by every key the retirement fenced, so a re-attach on any of them
  // (owner, physical, or a deleted alias) finds the same record. Bounded like the maps
  // it mirrors; an evicted record simply degrades to lifting the key it was handed.
  protected retiredPaneFencesByKey = new Map<string, RetiredPaneFence>()
  protected paneKeyAliasPersistenceListener: PaneKeyAliasPersistenceListener | null = null
  // Why: on-disk last-status cache path; null without a userDataPath (tests), where persistence is a no-op and only in-memory replay applies.
  protected lastStatusFilePath: string | null = null
  // Why: trailing-edge debounce timer, per-instance so test servers in one process don't share state.
  protected statusPersistTimer: ReturnType<typeof setTimeout> | null = null
  protected assistantMessageRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  protected promptSentDedupeByPaneKey = new Map<string, AgentPromptSentDedupeEntry>()
  protected activeHookTurnCompletedAtByPaneKey = new Map<string, number>()
  protected promptSentHashSalt = randomBytes(16).toString('hex')
  protected closedAgentStatusTabIds = new Set<string>()
  protected closedAgentStatusPaneKeys = new Set<string>()
  protected restartedStatusLaunchTokenHashByPaneKey = new Map<string, string>()
  protected connectionTimestampWatermarkById = new Map<string, number>()
  // Why: survives the row itself. A transport clear deletes the pane's status row on purpose
  // (absence, not completion), but the *age* of the evidence a later replay restates is not a
  // claim about the pane and must not be lost with it. Bounded like its sibling maps.
  protected evidenceObservedAtByPaneKey = new Map<string, number>()
  // Why: skip disk writes when the JSON exactly matches the last write; guards against re-firing trailing timers when nothing changed.
  protected lastWrittenJson: string | null = null
  // Why: main is the pane authority for local/WSL/SSH panes — hook HTTP, relay, and its own
  // OSC parse all converge on applyNormalizedStatus, so one sequencer covers every ingress here.
  protected readonly observations = new AgentStatusObservationSequencer(
    createAgentStatusAuthorityId('main-agent-hooks')
  )

  protected abstract withdrawReplayObservation(paneKey: string): void
  protected abstract ingestSpoolRecord(record: SpoolRecord): void
  protected abstract emitPaneStatusCleared(clear: AgentStatusClearIpcPayload): void
  protected abstract buildStatusChangeNotification(): {
    statuses: AgentHookStatusChangeEntry[]
    providerSessions: AgentHookProviderSessionIdentity[]
  }
  protected abstract notifyStatusChangeListeners(): void
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
    }
  ): 'accept' | 'restart' | 'suppress'
  protected abstract isClosedAgentStatusTabForPaneKey(paneKey: string): boolean
  protected abstract recordRetiredPaneFence(
    paneKeys: ReadonlySet<string>,
    aliases: readonly RetiredPaneAlias[]
  ): void
  protected abstract markPaneClosedForAgentStatus(paneKey: string): void
  protected abstract attachStatusTiming(
    payload: AgentHookEventPayload,
    now?: number
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
    origin?: AgentStatusObservationOrigin
  ): EnrichedAgentHookEventPayload
  protected abstract emitEnrichedStatus(enriched: EnrichedAgentHookEventPayload): void
  protected abstract clearAssistantMessageRetry(paneKey: string): void
  protected abstract clearCodexSubagentPoll(paneKey: string): void
  protected abstract clearAllCodexSubagentPolls(): void
  protected abstract scheduleCodexSubagentPoll(
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
  protected abstract clearPaneState(paneKey: string): void
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

  abstract _getStateForTests(): HookListenerState
  abstract _resetPromptSentDedupeForTests(): void
  abstract _resetConnectionTimestampWatermarksForTests(): void
}
