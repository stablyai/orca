import {
  reconcileRemoteCodexState,
  markCodexLeadTurnInterrupted
} from '../../../shared/agent-hook-listener/providers/codex-state'
import {
  resolveAgentStatusIdentity,
  shouldSuppressInheritedTerminalStatus
} from '../../../shared/agent-status-identity'
import { INTERRUPTED_DONE_LATE_WORKING_SUPPRESSION_MS } from './server-constants'
import type { EnrichedAgentHookEventPayload } from './server-types'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import type { AgentStatusObservationOrigin } from '../../../shared/agent-status-observation'
import {
  attachClaudeChildOnlyBoundary,
  attachClaudePermissionToolUseId,
  invalidateClaudeChildOnlyBoundary,
  shouldKeepClaudePermissionVisible
} from './server-claude-status-rules'
import { isToolProgressWorkingAfterInterrupt } from './server-status-identity'
import { AgentHookServerStatusApplication } from './server-status-application'

export abstract class AgentHookServerStatusUpdate extends AgentHookServerStatusApplication {
  protected applyNormalizedStatus(
    payload: AgentHookEventPayload,
    onAccepted?: () => void,
    origin: AgentStatusObservationOrigin = 'hook',
    observedAt?: number,
    mutationBefore?: EnrichedAgentHookEventPayload
  ): EnrichedAgentHookEventPayload {
    if (payload.hookEventName === 'UserPromptSubmit') {
      // Why: the prompt boundary is authoritative even when text is unchanged; its next OSC working row must not inherit the prior cron/background turn stamp.
      this.activeHookTurnCompletedAtByPaneKey.delete(payload.paneKey)
    }
    let previous = this.state.lastStatusByPaneKey.get(payload.paneKey) as
      | EnrichedAgentHookEventPayload
      | undefined
    const rowBefore = mutationBefore ?? previous
    const terminalHandle =
      payload.terminalHandle ??
      (previous?.terminalHandle && this.sameTerminalOwner(previous, payload)
        ? previous.terminalHandle
        : undefined)
    const terminalOwnedPayload =
      terminalHandle === payload.terminalHandle ? payload : { ...payload, terminalHandle }
    const connectionClearWatermark = terminalOwnedPayload.connectionId
      ? this.connectionTimestampWatermarkById.get(terminalOwnedPayload.connectionId)
      : undefined
    // Why: renderer ordering rejects older rows; live evidence must sort after reconnect clears and restored rows across clock rollback.
    const restoredStatusWatermark = previous?.restoredUnconfirmed ? previous.receivedAt : undefined
    const now = Math.max(
      Date.now(),
      (connectionClearWatermark ?? -1) + 1,
      (restoredStatusWatermark ?? -1) + 1
    )
    if (terminalOwnedPayload.connectionId) {
      this.connectionTimestampWatermarkById.set(terminalOwnedPayload.connectionId, now)
    }
    if (terminalOwnedPayload.providerSessionOnly) {
      // Why: identity-only rows survive replay but must not emit prompt telemetry or a fabricated status.
      onAccepted?.()
      const enriched = {
        ...this.attachStatusTiming(terminalOwnedPayload, now),
        observation: this.stampObservation(terminalOwnedPayload, origin, now)
      }
      this.clearAssistantMessageRetry(enriched.paneKey)
      this.runtimeObservedStatusPaneKeys.delete(enriched.paneKey)
      this.state.lastStatusByPaneKey.set(enriched.paneKey, enriched)
      this.commitStatusRowMutation(rowBefore, enriched)
      this.scheduleStatusPersist()
      this.notifyStatusChangeListeners()
      this.emitEnrichedStatus(enriched)
      return enriched
    }
    const stateReconciledPayload =
      terminalOwnedPayload.connectionId &&
      terminalOwnedPayload.payload.agentType === 'codex' &&
      terminalOwnedPayload.hookEventName
        ? {
            ...terminalOwnedPayload,
            payload: reconcileRemoteCodexState(
              this.state,
              terminalOwnedPayload.paneKey,
              terminalOwnedPayload.hookEventName,
              terminalOwnedPayload.toolAgentId,
              terminalOwnedPayload.payload,
              previous?.payload
            )
          }
        : terminalOwnedPayload
    const previousCodexRoot =
      stateReconciledPayload.payload.agentType === 'codex' &&
      stateReconciledPayload.toolAgentId &&
      previous?.payload.agentType === 'codex'
        ? previous
        : undefined
    const preservedProviderSession = !stateReconciledPayload.providerSession
      ? previousCodexRoot?.providerSession
      : undefined
    const preservedRootModel = !stateReconciledPayload.payload.model
      ? previousCodexRoot?.payload.model
      : undefined
    // Why: an SSH relay restart forgets root-only fields; child hooks must not erase durable resume/model identity.
    const rootContextPreservingPayload =
      preservedProviderSession || preservedRootModel
        ? {
            ...stateReconciledPayload,
            ...(preservedProviderSession ? { providerSession: preservedProviderSession } : {}),
            payload: preservedRootModel
              ? { ...stateReconciledPayload.payload, model: preservedRootModel }
              : stateReconciledPayload.payload
          }
        : stateReconciledPayload
    const boundaryReconciledPrevious = invalidateClaudeChildOnlyBoundary(
      previous,
      rootContextPreservingPayload
    )
    if (boundaryReconciledPrevious !== previous) {
      previous = boundaryReconciledPrevious
      if (previous) {
        this.state.lastStatusByPaneKey.set(previous.paneKey, previous)
        this.scheduleStatusPersist()
      }
    }
    const identity = resolveAgentStatusIdentity({
      existing: previous
        ? {
            agentType: previous.payload.agentType,
            state: previous.payload.state,
            updatedAt: previous.receivedAt,
            restoredUnconfirmed: previous.restoredUnconfirmed
          }
        : undefined,
      incoming: rootContextPreservingPayload.payload.agentType,
      now
    })
    if (
      previous &&
      shouldSuppressInheritedTerminalStatus({
        inheritedFromActivePane: identity.inheritedFromActivePane,
        incomingState: rootContextPreservingPayload.payload.state
      })
    ) {
      this.commitStatusRowMutation(rowBefore, previous)
      return previous
    }
    const identityResolvedPayload =
      identity.agentType === rootContextPreservingPayload.payload.agentType
        ? rootContextPreservingPayload
        : {
            ...rootContextPreservingPayload,
            payload: { ...rootContextPreservingPayload.payload, agentType: identity.agentType }
          }
    const effectivePayload = attachClaudePermissionToolUseId(previous, identityResolvedPayload)
    const boundaryAwarePayload = attachClaudeChildOnlyBoundary(previous, effectivePayload)
    if (previous && shouldKeepClaudePermissionVisible(previous, effectivePayload)) {
      this.commitStatusRowMutation(rowBefore, previous)
      return previous
    }
    // Why: some TUIs emit a delayed tool/working hook after Ctrl+C stopped the turn; don't let it resurrect the row.
    if (
      previous?.payload.state === 'done' &&
      previous.payload.interrupted === true &&
      effectivePayload.payload.state === 'done' &&
      previous.payload.agentType === effectivePayload.payload.agentType &&
      previous.payload.prompt === effectivePayload.payload.prompt &&
      Date.now() - previous.receivedAt <= INTERRUPTED_DONE_LATE_WORKING_SUPPRESSION_MS
    ) {
      this.commitStatusRowMutation(rowBefore, previous)
      return previous
    }
    if (
      previous?.payload.state === 'done' &&
      previous.payload.interrupted === true &&
      effectivePayload.payload.state === 'working' &&
      previous.payload.agentType === effectivePayload.payload.agentType &&
      previous.payload.prompt === effectivePayload.payload.prompt &&
      (effectivePayload.isReplay === true ||
        isToolProgressWorkingAfterInterrupt(effectivePayload) ||
        (effectivePayload.hasExplicitPrompt !== true &&
          Date.now() - previous.receivedAt <= INTERRUPTED_DONE_LATE_WORKING_SUPPRESSION_MS))
    ) {
      if (effectivePayload.payload.agentType === 'codex') {
        markCodexLeadTurnInterrupted(this.state, effectivePayload.paneKey)
      }
      this.commitStatusRowMutation(rowBefore, previous)
      return previous
    }
    if (
      effectivePayload.payload.state !== 'done' ||
      effectivePayload.payload.lastAssistantMessage
    ) {
      this.clearAssistantMessageRetry(effectivePayload.paneKey)
    }
    onAccepted?.()
    if (!identity.inheritedFromActivePane) {
      this.maybeTrackAgentPromptSent(effectivePayload, previous)
    }
    // Why carried forward only within one host: main's OSC parse resolves the handle, so a later
    // hook must not erase its terminal join; a connection change must not inherit another host's.
    const enriched = {
      ...this.attachStatusTiming(boundaryAwarePayload, now, observedAt),
      observation: this.stampObservation(boundaryAwarePayload, origin, observedAt ?? now)
    }
    if (
      typeof enriched.payload.turnCompletedAt === 'number' &&
      Number.isFinite(enriched.payload.turnCompletedAt)
    ) {
      this.activeHookTurnCompletedAtByPaneKey.set(
        enriched.paneKey,
        enriched.payload.turnCompletedAt
      )
    }
    // Why: an identity-matched event can still leave the aggregate backed only by another restored child; keep liveness reconciliation eligible.
    if (enriched.restoredUnconfirmed) {
      this.runtimeObservedStatusPaneKeys.delete(enriched.paneKey)
    } else {
      this.runtimeObservedStatusPaneKeys.add(enriched.paneKey)
    }
    this.state.lastStatusByPaneKey.set(enriched.paneKey, enriched)
    this.commitStatusRowMutation(rowBefore, enriched)
    // Why skipped for structured rows: the serializer drops them, so the whole walk and stringify
    // can only ever reproduce the last file — once per debounce window for a streaming chat.
    if (!enriched.structuredHost) {
      this.scheduleStatusPersist()
    }
    this.notifyStatusChangeListeners()
    this.emitEnrichedStatus(enriched)
    return enriched
  }

  protected refreshTerminalStatusEvidence(
    previous: EnrichedAgentHookEventPayload,
    mutationBefore?: EnrichedAgentHookEventPayload
  ): void {
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
    const refreshed: EnrichedAgentHookEventPayload = {
      ...payload,
      receivedAt: now,
      evidenceObservedAt: now,
      stateStartedAt,
      observation: this.stampObservation(payload, 'osc', now)
    }
    const firstRuntimeObservation = !this.runtimeObservedStatusPaneKeys.has(refreshed.paneKey)
    this.runtimeObservedStatusPaneKeys.add(refreshed.paneKey)
    this.state.lastStatusByPaneKey.set(refreshed.paneKey, refreshed)
    this.commitStatusRowMutation(mutationBefore ?? previous, refreshed)
    this.scheduleStatusPersist()
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
  }

  // Why: every status emit must reach plugins too, so a new early-return path
  // upstream cannot silently leave the plugin tap behind the main-window fanout.
  protected emitEnrichedStatus(enriched: EnrichedAgentHookEventPayload): void {
    this.onAgentStatus?.(enriched)
    for (const listener of this.enrichedStatusListeners) {
      try {
        listener(enriched)
      } catch (err) {
        console.error('[agent-hooks] enriched status listener threw', err)
      }
    }
  }
}
