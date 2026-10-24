import { deriveCliWriterTopology } from './cli-writer-observation'
import { createHash } from 'node:crypto'

import { getCohortAtEmit } from '../../telemetry/cohort-classifier'
import { track } from '../../telemetry/client'
import { isCommandCodeNewTurnWhileWorking } from '../../../shared/command-code-turn-boundary'
import { isNewTurnEvent } from '../../../shared/agent-hook-listener/provider-event-routing'
import { reduceHostTurnEnd } from '../../../shared/agent-hook-turn-end-timing'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import type {
  AgentStatusObservation,
  AgentStatusObservationOrigin
} from '../../../shared/agent-status-observation'
import { AGENT_STATUS_2A_CURRENT_PRODUCER_MODE } from '../../../shared/agent-status-legacy-adapter'
import type { AgentStatusState, ParsedAgentStatusPayload } from '../../../shared/agent-status-types'
import { admitLegacyAgentStatus } from '../../../shared/agent-hook-listener/listener-state'
import type { EnrichedAgentHookEventPayload } from './server-types'
import { agentTypeToPromptSentAgentKind } from './server-status-identity'
import { AgentHookServerStatusDisposition } from './server-status-disposition'

// Evicting remembered evidence makes later replay fall back to its arrival time.
const MAX_REMEMBERED_EVIDENCE_OBSERVATIONS = 1024

function mainAgentState(payload: ParsedAgentStatusPayload): AgentStatusState {
  return payload.mainAgent?.state ?? payload.state
}

/** Only live main-agent turn boundaries establish a start; replay and child events preserve it. */
function resolveTurnStartedAt(
  previous: EnrichedAgentHookEventPayload | undefined,
  payload: AgentHookEventPayload,
  at: number
): number | undefined {
  if (
    payload.source !== undefined &&
    payload.toolAgentId === undefined &&
    payload.isReplay !== true &&
    payload.providerSessionOnly !== true &&
    isNewTurnEvent(payload.source, payload.hookEventName)
  ) {
    return payload.payload.sessionBoundary === true ? undefined : at
  }
  // An undated return to work cannot inherit the completed turn's start.
  if (
    previous &&
    mainAgentState(previous.payload) === 'done' &&
    mainAgentState(payload.payload) !== 'done'
  ) {
    return undefined
  }
  return previous?.turnStartedAt
}

export abstract class AgentHookServerStatusApplication extends AgentHookServerStatusDisposition {
  protected refreshTerminalStatusEvidence(
    previous: EnrichedAgentHookEventPayload,
    mutationBefore?: EnrichedAgentHookEventPayload,
    emitEnrichedStatus = false,
    newRun = false
  ): void {
    if (!this.canWriteLegacyStatusRow(previous)) {
      return
    }
    const connectionClearWatermark = previous.connectionId
      ? this.connectionTimestampWatermarkById.get(previous.connectionId)
      : undefined
    const now = Math.max(Date.now(), (connectionClearWatermark ?? -1) + 1)
    if (previous.connectionId) {
      this.connectionTimestampWatermarkById.set(previous.connectionId, now)
    }
    const {
      receivedAt: _receivedAt,
      evidenceObservedAt: _evidenceObservedAt,
      stateStartedAt,
      observation: _observation,
      restoredUnconfirmed: _restoredUnconfirmed,
      isReplay: _isReplay,
      ...payload
    } = previous
    const refreshed = deriveCliWriterTopology(
      {
        ...payload,
        receivedAt: now,
        evidenceObservedAt: now,
        stateStartedAt,
        observation: this.stampObservation(payload, 'osc', now)
      },
      mutationBefore ?? previous,
      this.cliWriterExecutionMatches,
      newRun
    )
    const firstRuntimeObservation = !this.runtimeObservedStatusPaneKeys.has(refreshed.paneKey)
    this.runtimeObservedStatusPaneKeys.add(refreshed.paneKey)
    if (!this.writeLegacyStatusRow(refreshed)) {
      return
    }
    this.commitStatusRowMutation(mutationBefore ?? previous, refreshed)
    this.scheduleStatusPersist()
    // Hidden resume identity can still say working; it must not renew awake or mobile leases.
    if (refreshed.providerSessionOnly === true) {
      return
    }
    if (firstRuntimeObservation) {
      this.notifyStatusChangeListeners()
    }
    this.emitStatusFreshnessObservation({
      paneKey: refreshed.paneKey,
      state: refreshed.payload.state,
      receivedAt: refreshed.receivedAt,
      observedInCurrentRuntime: true,
      ...(refreshed.worktreeId ? { worktreeId: refreshed.worktreeId } : {}),
      ...(refreshed.terminalHandle ? { terminalHandle: refreshed.terminalHandle } : {})
    })
    if (emitEnrichedStatus) {
      this.emitEnrichedStatus(refreshed)
    }
  }

  protected writeLegacyStatusRow(entry: EnrichedAgentHookEventPayload): boolean {
    return admitLegacyAgentStatus(
      this.state,
      'main-status-update',
      entry,
      AGENT_STATUS_2A_CURRENT_PRODUCER_MODE
    )
  }
  /** Producer clocks date evidence and state; receivedAt retains delivery order. */
  protected attachStatusTiming(
    payload: AgentHookEventPayload,
    now = Date.now(),
    observedAt?: number
  ): EnrichedAgentHookEventPayload {
    const previous = this.state.lastStatusByPaneKey.get(payload.paneKey) as
      | EnrichedAgentHookEventPayload
      | undefined
    const commandCodeNewTurn =
      previous !== undefined &&
      isCommandCodeNewTurnWhileWorking({
        agentType: payload.payload.agentType,
        previousState: previous.payload.state,
        incomingState: payload.payload.state,
        previousPrompt: previous.payload.prompt,
        incomingPrompt: payload.payload.prompt,
        hasExplicitPrompt: payload.hasExplicitPrompt,
        previousPromptInteractionKey: previous.promptInteractionKey,
        incomingPromptInteractionKey: payload.promptInteractionKey
      })
    const stateStartedAt =
      previous && previous.payload.state === payload.payload.state && !commandCodeNewTurn
        ? previous.stateStartedAt
        : (observedAt ?? now)
    const turnStartedAt = resolveTurnStartedAt(previous, payload, observedAt ?? now)
    // Relay rows carry their execution host's turn-end evidence.
    const { hostTurn, ...turnEnd } = reduceHostTurnEnd(
      previous,
      payload,
      observedAt ?? now,
      payload.connectionId === null
    )
    const {
      stopHookActive: _stopHookActive,
      nativeTurnKey: _nativeTurnKey,
      turnEndedAt: _turnEndedAt,
      turnEndDisposition: _turnEndDisposition,
      hostTurn: _hostTurn,
      ...event
    } = payload
    return {
      ...event,
      receivedAt: now,
      evidenceObservedAt: observedAt ?? this.resolveEvidenceObservedAt(payload, previous, now),
      stateStartedAt,
      // Producers cannot declare a main-agent turn start.
      turnStartedAt,
      ...turnEnd,
      ...(hostTurn ? { hostTurn } : {})
    }
  }

  /** Replay keeps evidence age separate from arrival order; unknown age falls back to now. */
  private resolveEvidenceObservedAt(
    payload: AgentHookEventPayload,
    previous: EnrichedAgentHookEventPayload | undefined,
    now: number
  ): number {
    const remembered =
      previous?.evidenceObservedAt ?? this.evidenceObservedAtByPaneKey.get(payload.paneKey)
    const observedAt = payload.isReplay === true && remembered !== undefined ? remembered : now
    this.evidenceObservedAtByPaneKey.delete(payload.paneKey)
    this.evidenceObservedAtByPaneKey.set(payload.paneKey, observedAt)
    while (this.evidenceObservedAtByPaneKey.size > MAX_REMEMBERED_EVIDENCE_OBSERVATIONS) {
      const oldest = this.evidenceObservedAtByPaneKey.keys().next().value
      if (typeof oldest !== 'string') {
        break
      }
      this.evidenceObservedAtByPaneKey.delete(oldest)
    }
    return observedAt
  }

  protected hashPromptForTelemetryDedupe(prompt: string): string {
    return createHash('sha256')
      .update(this.promptSentHashSalt)
      .update('\0')
      .update(prompt)
      .digest('hex')
  }

  protected maybeTrackAgentPromptSent(
    payload: AgentHookEventPayload,
    previousStatus: EnrichedAgentHookEventPayload | undefined
  ): void {
    if (payload.isReplay === true || payload.hasExplicitPrompt !== true) {
      return
    }
    const prompt = payload.payload.prompt?.trim() ?? ''
    if (prompt.length === 0) {
      return
    }
    const agentKind = agentTypeToPromptSentAgentKind(payload.payload.agentType)
    const promptHash = this.hashPromptForTelemetryDedupe(prompt)
    const promptInteractionKey =
      typeof payload.promptInteractionKey === 'string' &&
      payload.promptInteractionKey.trim().length > 0
        ? payload.promptInteractionKey.trim()
        : undefined
    const previousDedupe = this.promptSentDedupeByPaneKey.get(payload.paneKey)
    const isCompletedTurnBoundary =
      previousStatus?.payload.state === 'done' && payload.payload.state === 'working'
    if (
      previousDedupe?.agentKind === agentKind &&
      previousDedupe.promptInteractionKey !== undefined &&
      previousDedupe.promptInteractionKey === promptInteractionKey &&
      (agentKind === 'opencode' || previousDedupe.promptHash === promptHash)
    ) {
      return
    }
    if (
      previousDedupe?.agentKind === agentKind &&
      previousDedupe.promptHash === promptHash &&
      !(
        previousStatus?.payload.state === 'done' &&
        payload.payload.state === 'done' &&
        previousDedupe.promptInteractionKey !== undefined &&
        promptInteractionKey !== undefined &&
        previousDedupe.promptInteractionKey !== promptInteractionKey
      ) &&
      !isCompletedTurnBoundary
    ) {
      return
    }
    this.promptSentDedupeByPaneKey.set(payload.paneKey, {
      agentKind,
      promptHash,
      promptInteractionKey
    })
    try {
      // Hooks prove prompt submission but cannot identify the launching UI.
      track('agent_prompt_sent', {
        agent_kind: agentKind,
        launch_source: 'unknown',
        request_kind: 'followup',
        ...getCohortAtEmit()
      })
    } catch (err) {
      console.error('[agent-hooks] prompt-sent telemetry failed', err)
    }
  }

  /** Sequence every ingress with runtime provenance, including hook/OSC precedence. */
  protected stampObservation(
    payload: AgentHookEventPayload,
    origin: AgentStatusObservationOrigin,
    observedAt: number
  ): AgentStatusObservation {
    return this.observations.observe(payload.paneKey, {
      origin,
      observedAt,
      // Use provider classifiers; boundary event names vary.
      boundary:
        payload.source !== undefined && isNewTurnEvent(payload.source, payload.hookEventName),
      kind: payload.providerSessionOnly
        ? 'identity-only'
        : // Replay and OSC restate status rather than establish a fresh transition.
          payload.isReplay === true || origin === 'osc'
          ? 'snapshot'
          : 'transition'
    })
  }
}
