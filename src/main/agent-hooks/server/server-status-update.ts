import {
  adoptRelayedRow,
  currentOwner,
  transitionHookPresence
} from '../../../shared/agent-hook-presence-transition'
import { PaneOwnerProbes } from '../../../shared/agent-pane-owner-probes'
import {
  reconcileRemoteCodexState,
  markCodexLeadTurnInterrupted
} from '../../../shared/agent-hook-listener/providers/codex-state'
import type { EnrichedAgentHookEventPayload } from './server-types'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import type { AgentStatusObservationOrigin } from '../../../shared/agent-status-observation'
import { ClaudeOwedNotificationExpiryTimers } from '../../../shared/claude-owed-notification-expiry-timers'
import { setClaudeMainAgentTurnState } from '../../../shared/agent-hook-listener/providers/claude-roster-state'
import {
  attachClaudePermissionToolUseId,
  pairedClaudeNonAgentWork,
  shouldKeepClaudePermissionVisible,
  withHeldChildWaitMainAgent
} from './server-claude-status-rules'
import { isStaleGrokTurnEnd } from './server-grok-status-rules'
import { resolveCancelVerdictLatch } from './server-cancel-verdict-latch'
import { AgentHookServerStatusApplication } from './server-status-application'

export abstract class AgentHookServerStatusUpdate extends AgentHookServerStatusApplication {
  protected readonly claudeOwedNotificationExpiry = new ClaudeOwedNotificationExpiryTimers(
    this.state
  )

  protected readonly paneOwnerProbes = new PaneOwnerProbes({
    ownerOf: (paneKey) =>
      currentOwner(this.state.lastStatusByPaneKey.get(this.resolvePaneKeyAlias(paneKey)))?.process,
    checkOwner: (paneKey) => this.probeOwnerProcess(paneKey)
  })

  // Why here: every stored row passes through, including a cancel inference and a pane move.
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
    incoming: AgentHookEventPayload & { authorityRestartId?: string },
    onAccepted?: () => void,
    origin: AgentStatusObservationOrigin = 'hook',
    observedAt?: number,
    mutationBefore?: EnrichedAgentHookEventPayload
  ): EnrichedAgentHookEventPayload | undefined {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Main admits enriched legacy rows; the shared view declares their base event type.
    const previous = this.state.lastStatusByPaneKey.get(incoming.paneKey) as
      | EnrichedAgentHookEventPayload
      | undefined
    const apply = (event: typeof incoming) =>
      this.applyOwnedStatus(event, previous, onAccepted, origin, observedAt, mutationBefore)
    // Why: terminal ingest already placed its signal under the owner (terminals never claim); a
    // relayed row's owner was decided by its relay; main decides only for local hook producers.
    if (origin !== 'hook') {
      return apply(incoming)
    }
    if (incoming.connectionId !== null) {
      return apply(adoptRelayedRow(incoming, previous))
    }
    return this.paneOwnerProbes.admit(
      incoming.paneKey,
      transitionHookPresence(incoming, previous, previous?.receivedAt),
      {
        write: apply,
        reapply: () => {
          if (!this.server) {
            return
          }
          // Why: the owner's exit cleared the pane's prompt cache; the replayed guest's turn is now
          // the pane's, so its later events (a tool use) keep that turn's prompt.
          if (incoming.payload.prompt) {
            this.state.lastPromptByPaneKey.set(incoming.paneKey, incoming.payload.prompt)
          }
          this.applyNormalizedStatus(incoming, onAccepted)
        }
      }
    )
  }

  private applyOwnedStatus(
    incoming: AgentHookEventPayload & { authorityRestartId?: string },
    previous: EnrichedAgentHookEventPayload | undefined,
    onAccepted: (() => void) | undefined,
    origin: AgentStatusObservationOrigin,
    observedAt: number | undefined,
    mutationBefore: EnrichedAgentHookEventPayload | undefined
  ): EnrichedAgentHookEventPayload | undefined {
    const { authorityRestartId, ...payload } = incoming
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
    if (payload.hookEventName === 'UserPromptSubmit') {
      // Why: the prompt boundary is authoritative even when text is unchanged; its next OSC working row must not inherit the prior cron/background turn stamp.
      this.activeHookTurnCompletedAtByPaneKey.delete(payload.paneKey)
    }
    const rowBefore = mutationBefore ?? previous
    const terminalHandle =
      payload.terminalHandle ??
      (previous?.terminalHandle && this.sameTerminalOwner(previous, payload)
        ? previous.terminalHandle
        : undefined)
    const terminalOwnedPayload =
      terminalHandle === payload.terminalHandle ? payload : { ...payload, terminalHandle }
    if (previous && isStaleGrokTurnEnd(previous, terminalOwnedPayload)) {
      // Why: Grok turn-end hooks may arrive after the next prompt, including across relay restart.
      this.commitStatusRowMutation(rowBefore, previous)
      return previous
    }
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
      if (!this.writeLegacyStatusRow(enriched)) {
        return undefined
      }
      this.commitStatusRowMutation(rowBefore, enriched)
      this.scheduleStatusPersist()
      this.notifyStatusChangeListeners()
      this.emitEnrichedStatus(enriched)
      return enriched
    }
    const stateReconciledPayload =
      terminalOwnedPayload.connectionId &&
      terminalOwnedPayload.payload.agentType === 'codex' &&
      (terminalOwnedPayload.hookEventName || terminalOwnedPayload.payload.mainAgent)
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
    const attachedPayload = attachClaudePermissionToolUseId(previous, stateReconciledPayload)
    // Why before the permission hold: that hold adopts the event's `mainAgent`, and a relay's
    // restatement of a main agent the desktop cancelled must not replace the cancel.
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
      // Why: a child's prompt leaves the main agent running, so the held row takes its `mainAgent` and
      // must take the same event's background evidence; a main agent's own prompt blocks it, so not there.
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
      // Why: pushed readers must see the new `mainAgent` a snapshot reader already does.
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
    this.maybeTrackAgentPromptSent(effectivePayload, previous)
    // Why carried forward only within one host: main's OSC parse resolves the handle, so a later
    // hook must not erase its terminal join; a connection change must not inherit another host's.
    const { claudeRunningNonAgentTask: _unpaired, ...unpairedPayload } = effectivePayload
    const runningNonAgentTask = pairedClaudeNonAgentWork(previous, effectivePayload)
    const pairedPayload =
      runningNonAgentTask === undefined
        ? unpairedPayload
        : { ...unpairedPayload, claudeRunningNonAgentTask: runningNonAgentTask }
    const enriched = {
      ...this.attachStatusTiming(pairedPayload, now, observedAt),
      observation: this.stampObservation(pairedPayload, origin, observedAt ?? now)
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
    if (!this.writeLegacyStatusRow(enriched)) {
      return undefined
    }
    this.commitStatusRowMutation(rowBefore, enriched)
    // Why skipped for structured rows: the serializer drops them, so the whole walk and stringify
    // can only ever reproduce the last file — once per debounce window for a streaming chat.
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
