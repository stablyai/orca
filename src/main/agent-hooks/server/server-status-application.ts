import { createHash } from 'node:crypto'

import { getCohortAtEmit } from '../../telemetry/cohort-classifier'
import { track } from '../../telemetry/client'
import { isCommandCodeNewTurnWhileWorking } from '../../../shared/command-code-turn-boundary'
import { isNewTurnEvent } from '../../../shared/agent-hook-listener/provider-event-routing'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import type {
  AgentStatusObservation,
  AgentStatusObservationOrigin
} from '../../../shared/agent-status-observation'
import type { EnrichedAgentHookEventPayload } from './server-types'
import { agentTypeToPromptSentAgentKind } from './server-status-identity'
import { AgentHookServerStatusDisposition } from './server-status-disposition'

/** Bounds the retained observation clock; eviction only degrades a replay to `now`. */
const MAX_REMEMBERED_EVIDENCE_OBSERVATIONS = 1024

export abstract class AgentHookServerStatusApplication extends AgentHookServerStatusDisposition {
  protected attachStatusTiming(
    payload: AgentHookEventPayload,
    now = Date.now()
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
        : now
    // Why: `stateStartedAt` tracks the current state, while `receivedAt` tracks every arrival.
    return {
      ...payload,
      receivedAt: now,
      evidenceObservedAt: this.resolveEvidenceObservedAt(payload, previous, now),
      stateStartedAt
    }
  }

  /**
   * A replay restates evidence already observed; it is not a new observation. Keeping
   * `receivedAt` at `now` preserves delivery order (the connection-clear watermark and the
   * renderer's four `<` drops all depend on it), while this clock records when the evidence
   * was actually seen — so the staleness window measures age, not reconnect count.
   * Without a remembered time the honest answer is `now`, which is today's behaviour.
   */
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
      // Why: hooks prove a turn was submitted but not which UI launched the terminal; keep attribution low-cardinality.
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

  /** Stamp who observed this event, in what order, on main's clock. Nothing reads it yet
   *  (STA-4293) — it is stamped here because every main-side ingress funnels through
   *  applyNormalizedStatus, so no origin can silently arrive untagged. */
  protected stampObservation(
    payload: AgentHookEventPayload,
    origin: AgentStatusObservationOrigin,
    observedAt: number
  ): AgentStatusObservation {
    return this.observations.observe(payload.paneKey, {
      origin,
      observedAt,
      // Why: reuse the listener's own per-provider classifier; a second list of raw event-name
      // literals here would strand the providers whose boundary event is named anything else.
      boundary:
        payload.source !== undefined && isNewTurnEvent(payload.source, payload.hookEventName),
      kind: payload.providerSessionOnly
        ? 'identity-only'
        : // Why: a replay restates a turn that already happened, and OSC 9999 repaints the
          // current state rather than announcing a change — neither is a fresh transition.
          payload.isReplay === true || origin === 'osc'
          ? 'snapshot'
          : 'transition'
    })
  }
}
