import type {
  AgentProcessPresence,
  AgentProcessVerdict
} from '../../../shared/agent-status/process/agent-process-presence'

import type { HookListenerState } from '../../../shared/agent-hook-listener/listener-state'

import type {
  AgentStatusObservation,
  AgentStatusObservationOrigin
} from '../../../shared/agent-status/contracts/agent-status-observation'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import type { AgentHookSource } from '../../../shared/agent-hook-listener/transport/agent-hook-relay'
import type { AgentStatusClearIpcPayload } from '../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { LegacyPaneKeyAliasEntry } from '../../../shared/persisted-state-types'
import type { SpoolRecord } from '../../../shared/agent-hook-listener/transport/agent-hook-spool'

import type {
  AgentHookAuthorityEvidence,
  AgentHookProviderSessionIdentity,
  AgentHookStatusChangeEntry,
  AgentHookStatusFreshnessObservation,
  AgentStatusDispositionEvent,
  EnrichedAgentHookEventPayload,
  NormalizedLocalHook,
  RetiredPaneAlias,
  RetiredPaneFence
} from './server-types'

import type { LastStatusStore } from './last-status-store'

export abstract class AgentHookServerStateContract {
  protected abstract state: HookListenerState

  protected abstract withdrawReplayObservation(paneKey: string): void

  protected abstract getTmuxSelectedStatus(
    paneKey: string
  ): EnrichedAgentHookEventPayload | undefined

  protected abstract deleteTmuxSelectedStatus(
    paneKey: string
  ): EnrichedAgentHookEventPayload | undefined

  protected abstract clearTmuxInnerSubjects(paneKey: string): void

  protected abstract clearTmuxTabSubjects(tabId: string): void

  protected abstract ingestSpoolRecord(record: SpoolRecord, answerBy?: number): Promise<void> | void

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
    event?: AgentStatusDispositionEvent
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

  protected abstract scheduleStatusPersist(): void

  protected abstract runStatusPersist(): boolean

  protected abstract getStatusStore(): LastStatusStore | null

  abstract _getStateForTests(): HookListenerState

  abstract _resetPromptSentDedupeForTests(): void

  abstract _resetConnectionTimestampWatermarksForTests(): void
}
