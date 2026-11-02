import { retainHookRootContext } from '../../../shared/agent-hook-listener/pane-provider-session'
import { deriveCliWriterTopology } from './cli-writer-observation'
import { previewHookPresence } from '../../../shared/agent-hook-presence-transition'
import {
  reconcileCodexStatusEvent,
  markCodexLeadTurnInterrupted
} from '../../../shared/agent-hook-listener/providers/codex-state'
import {
  resolveAgentStatusIdentity,
  shouldSuppressInheritedTerminalStatus
} from '../../../shared/agent-status-identity'
import type { EnrichedAgentHookEventPayload, IncomingAgentHookEvent } from './server-types'
import type { AgentStatusObservationOrigin } from '../../../shared/agent-status-observation'
import { ClaudeOwedNotificationExpiryTimers } from '../../../shared/claude-owed-notification-expiry-timers'
import { setClaudeMainAgentTurnState } from '../../../shared/agent-hook-listener/providers/claude-roster-state'
import {
  attachClaudePermissionToolUseId,
  pairedClaudeNonAgentWork,
  shouldKeepClaudePermissionVisible,
  withHeldChildWaitMainAgent
} from './server-claude-status-rules'
import { isForeignTurnHook } from './server-foreign-turn-hook'
import { resolveCancelVerdictLatch } from './server-cancel-verdict-latch'
import { AgentHookServerStatusApplication } from './server-status-application'
import { claimsPaneAfterExit } from './agent-exit-evidence'

export abstract class AgentHookServerStatusUpdate extends AgentHookServerStatusApplication {
  protected readonly claudeOwedNotificationExpiry = new ClaudeOwedNotificationExpiryTimers(
    this.state
  )

  // Every row mutation passes here, including cancellation and pane moves.
  protected override commitStatusRowMutation(
    before: EnrichedAgentHookEventPayload | null | undefined,
    after: EnrichedAgentHookEventPayload | null | undefined,
    emit = true
  ): boolean {
    if (after) {
      this.claudeOwedNotificationExpiry.arm(after.paneKey, (row) => {
        if (this.server) {
          this.applyNormalizedStatus(row)
        }
      })
    }
    return super.commitStatusRowMutation(before, after, emit)
  }

  protected applyNormalizedStatus(
    incoming: IncomingAgentHookEvent,
    onAccepted?: () => void,
    origin: AgentStatusObservationOrigin = 'hook',
    observedAt?: number,
    mutationBefore?: EnrichedAgentHookEventPayload,
    newRun = false,
    retireBinding = false
  ): EnrichedAgentHookEventPayload | undefined {
    const rootContext = previewHookPresence(
      incoming,
      this.state.lastStatusByPaneKey.get(incoming.paneKey),
      origin === 'hook' || origin === 'launch',
      retireBinding
    )
    const { event: rootIdentityIncoming, statusAdmissionSession } = rootContext
    const transitioned = rootContext.transitioned
    if (!transitioned) {
      return undefined
    }
    const enrichedTransition = { ...rootIdentityIncoming, ...transitioned }
    const { authorityRestartId, codexRosterAuthority, ...payload } = enrichedTransition
    if (!this.canWriteLegacyStatusRow(payload)) {
      return undefined
    }
    if (payload.agentPresence?.ended) {
      this.reconcileEndedProcessForPaneKeys([payload.paneKey], {
        preserveResumeIdentity: true,
        endedPresence: payload.agentPresence
      })
      return undefined
    }
    const priorExit =
      this.agentExitedAtByPaneKey.get(this.resolvePaneKeyAlias(payload.paneKey)) ??
      this.agentExitedAtByPaneKey.get(payload.paneKey)
    // Use the sender's identity before transition logic can replace it with the cached owner.
    if (
      priorExit &&
      claimsPaneAfterExit({ ...payload, agentPresence: incoming.agentPresence }, priorExit)
    ) {
      this.forgetAgentExit(payload.paneKey)
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Main admits enriched legacy rows; the shared view declares their base event type.
    const previous = this.state.lastStatusByPaneKey.get(payload.paneKey) as
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
    if (previous && isForeignTurnHook(previous, terminalOwnedPayload)) {
      // A lagging Grok end or a relayed Codex side thread keeps the row, even across relay restart.
      this.commitStatusRowMutation(rowBefore, previous)
      return previous
    }
    const connectionClearWatermark = terminalOwnedPayload.connectionId
      ? this.connectionTimestampWatermarkById.get(terminalOwnedPayload.connectionId)
      : undefined
    const restoredStatusWatermark = previous?.restoredUnconfirmed ? previous.receivedAt : undefined
    // Delivery ordering and identity freshness must use the same clock across rollback.
    const now = Math.max(
      Date.now(),
      (connectionClearWatermark ?? -1) + 1,
      (restoredStatusWatermark ?? -1) + 1
    )
    const identity = resolveAgentStatusIdentity({
      existing:
        previous && this.sameTerminalOwner(previous, terminalOwnedPayload)
          ? {
              agentType: previous.payload.agentType,
              state: previous.payload.state,
              updatedAt: previous.receivedAt,
              restoredUnconfirmed: previous.restoredUnconfirmed,
              agentPresence: previous.providerSessionOnly ? undefined : rootContext.owner
            }
          : undefined,
      incoming: terminalOwnedPayload.payload.agentType,
      // Relay process presence is the host's owner verdict; scoped session bytes only compare this hook.
      incomingProcess: payload.connectionId ? undefined : incoming.agentPresence?.process,
      incomingSession: statusAdmissionSession,
      now
    })
    if (
      previous &&
      shouldSuppressInheritedTerminalStatus({
        inheritedFromActivePane: identity.inheritedFromActivePane
      })
    ) {
      this.commitStatusRowMutation(rowBefore, previous)
      return previous
    }
    // Any submitted prompt (incl. a replayed Codex start) opens a new turn; OSC must not inherit the old stamp.
    if (payload.hookEventName === 'UserPromptSubmit' || payload.hasExplicitPrompt === true) {
      this.activeHookTurnCompletedAtByPaneKey.delete(payload.paneKey)
    }
    if (terminalOwnedPayload.connectionId) {
      this.connectionTimestampWatermarkById.set(terminalOwnedPayload.connectionId, now)
    }
    if (terminalOwnedPayload.providerSessionOnly) {
      // Identity-only replay must not fabricate status or prompt telemetry.
      onAccepted?.()
      const enriched = deriveCliWriterTopology(
        {
          ...this.attachStatusTiming(terminalOwnedPayload, now),
          observation: this.stampObservation(terminalOwnedPayload, origin, now)
        },
        rowBefore,
        this.cliWriterExecutionMatches,
        newRun,
        incoming.agentPresence?.process
      )
      this.clearAssistantMessageRetry(enriched.paneKey)
      this.runtimeObservedStatusPaneKeys.delete(enriched.paneKey)
      if (!this.writeLegacyStatusRow(enriched)) {
        return undefined
      }
      this.commitStatusRowMutation(rowBefore, enriched)
      this.scheduleStatusPersist()
      this.notifyStatusChangeListeners()
      this.emitEnrichedStatus(enriched)
      return enriched
    }
    const stateReconciledPayload = reconcileCodexStatusEvent(
      this.state,
      terminalOwnedPayload,
      previous?.payload,
      codexRosterAuthority
    )
    // Relay restart loses root context; child hooks must not erase persisted resume/model identity.
    const rootContextPreservingPayload = retainHookRootContext(
      stateReconciledPayload,
      previous,
      origin === 'hook',
      !!previous && this.sameTerminalOwner(previous, stateReconciledPayload),
      rootContext.returningProviderSession
    )
    const identityResolvedPayload =
      identity.agentType === rootContextPreservingPayload.payload.agentType
        ? rootContextPreservingPayload
        : {
            ...rootContextPreservingPayload,
            payload: { ...rootContextPreservingPayload.payload, agentType: identity.agentType }
          }
    const attachedPayload = attachClaudePermissionToolUseId(previous, identityResolvedPayload)
    // Resolve cancellation before permission holds adopt a replayed main-agent observation.
    const latch = resolveCancelVerdictLatch(previous, attachedPayload, Date.now())
    if (latch.hold) {
      if (
        attachedPayload.connectionId === null &&
        attachedPayload.payload.agentType === 'claude' &&
        previous?.connectionId === null &&
        previous.payload.mainAgent?.state === 'done' &&
        this.sameTerminalOwner(previous, attachedPayload)
      ) {
        // A refused late hook already mutated the local producer; keep its idle lease clock.
        setClaudeMainAgentTurnState(this.state, attachedPayload.paneKey, previous.payload.mainAgent)
      }
      if (
        attachedPayload.payload.agentType === 'codex' &&
        attachedPayload.payload.state === 'working'
      ) {
        markCodexLeadTurnInterrupted(this.state, attachedPayload.paneKey)
      }
      this.commitStatusRowMutation(rowBefore, previous)
      return previous
    }
    const effectivePayload = latch.event
    if (previous && shouldKeepClaudePermissionVisible(previous, effectivePayload)) {
      const held = withHeldChildWaitMainAgent(previous, effectivePayload)
      // Child prompts preserve main-agent progress and its paired shell evidence; the main agent's own waits do not.
      if (previous.toolAgentId) {
        onAccepted?.()
      }
      if (held !== previous) {
        if (!this.writeLegacyStatusRow(held)) {
          return undefined
        }
        this.scheduleStatusPersist()
      }
      this.commitStatusRowMutation(rowBefore, held)
      // Pushed readers need main-agent changes already visible in snapshots.
      if (held.payload !== previous.payload) {
        this.emitEnrichedStatus(held)
      }
      return held
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
    // Preserve terminal joins only within one host; settlement lists vouch only for this transition.
    const {
      claudeRunningNonAgentTask: _unpaired,
      claudeSettledRequests: _settled,
      ...unpairedPayload
    } = effectivePayload
    const runningNonAgentTask = pairedClaudeNonAgentWork(previous, effectivePayload)
    const pairedPayload =
      runningNonAgentTask === undefined
        ? unpairedPayload
        : { ...unpairedPayload, claudeRunningNonAgentTask: runningNonAgentTask }
    const enriched = deriveCliWriterTopology(
      {
        ...this.attachStatusTiming(pairedPayload, now, observedAt),
        observation: this.stampObservation(pairedPayload, origin, observedAt ?? now)
      },
      rowBefore,
      this.cliWriterExecutionMatches,
      newRun,
      incoming.agentPresence?.process
    )
    if (
      typeof enriched.payload.turnCompletedAt === 'number' &&
      Number.isFinite(enriched.payload.turnCompletedAt)
    ) {
      this.activeHookTurnCompletedAtByPaneKey.set(
        enriched.paneKey,
        enriched.payload.turnCompletedAt
      )
    }
    // Other restored children can still hold the aggregate open; keep liveness reconciliation eligible.
    if (enriched.restoredUnconfirmed) {
      this.runtimeObservedStatusPaneKeys.delete(enriched.paneKey)
    } else {
      this.runtimeObservedStatusPaneKeys.add(enriched.paneKey)
    }
    if (!this.writeLegacyStatusRow(enriched)) {
      return undefined
    }
    this.commitStatusRowMutation(rowBefore, enriched)
    // Structured rows serialize nothing; skip the persistence walk for streaming chat updates.
    if (!enriched.structuredHost) {
      this.scheduleStatusPersist()
    }
    this.notifyStatusChangeListeners()
    this.emitEnrichedStatus(
      authorityRestartId && payload.isReplay !== true
        ? { ...enriched, authorityRestartId }
        : enriched
    )
    return enriched
  }
}
