import {
  admitLegacyAgentStatus,
  clearPaneProcessCacheState
} from '../../../shared/agent-hook-listener/listener-state'

import { AGENT_STATUS_2A_CURRENT_PRODUCER_MODE } from '../../../shared/agent-status/transport/agent-status-legacy-adapter'

import { pickParsedAgentStatusPayload } from '../../../shared/agent-status/contracts/agent-status-types'
import type { EnrichedAgentHookEventPayload } from './server-types'
import { AgentHookServerAuthorityFences } from './server-authority-fences'
import { endedPresenceOf, recordAgentExit } from './agent-exit-evidence'
import type { LaunchResumeIdentityEvent } from './launch-resume-identity-event'
import { agentProviderSessionsEqual } from '../../../shared/agent-session/lifecycle/resume/agent-provider-session-equality'

export abstract class AgentHookServerPaneSleep extends AgentHookServerAuthorityFences {
  abstract dropStatusEntry(paneKey: string, options?: { preserveResumeIdentity?: boolean }): void

  pruneUnplacedSleepingPanes(): void {
    for (const [paneKey, entry] of this.state.lastStatusByPaneKey) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the server caches enriched accepted rows, while the listener contract exposes their base shape.
      const row = entry as EnrichedAgentHookEventPayload
      if (row.paneSleep && this.terminalPaneLifecycle?.isPlaced(row) === false) {
        this.retirePaneAuthority(paneKey)
        this.emitPaneStatusCleared({ paneKey })
      }
    }
  }

  retireSleepingPaneOnSpawn(
    paneKey: string,
    resumed?: Pick<LaunchResumeIdentityEvent, 'agentType' | 'providerSession'>
  ): void {
    const resolved = this.resolvePaneKeyAlias(paneKey)
    const row = this.state.lastStatusByPaneKey.get(resolved) as
      | EnrichedAgentHookEventPayload
      | undefined
    if (!row?.paneSleep) {
      return
    }
    // A dropped resume leaves a shell; only the same conversation keeps its accepted turn.
    if (
      resumed &&
      row.payload.agentType === resumed.agentType &&
      agentProviderSessionsEqual(resumed.agentType, row.providerSession, resumed.providerSession)
    ) {
      const {
        paneSleep: _paneSleep,
        agentPresence: _presence,
        terminalHandle: _handle,
        ...accepted
      } = row
      const rest = { ...accepted, evidenceObservedAt: Date.now() }
      admitLegacyAgentStatus(
        this.state,
        'main-status-cleanup',
        rest,
        AGENT_STATUS_2A_CURRENT_PRODUCER_MODE
      )
      this.commitStatusRowMutation(row, rest)
      this.scheduleStatusPersist()
      this.notifyStatusChangeListeners()
      this.onAgentStatus?.({ ...rest, isReplay: true })
    } else {
      this.dropStatusEntry(resolved, { preserveResumeIdentity: false })
      this.emitPaneStatusCleared({ paneKey: resolved })
    }
    // The sleep-time exit belongs to the process that the spawn replaces.
    this.forgetAgentExit(resolved)
  }

  /** The physical stop changes presence, never the accepted completion or its clocks. */
  settleTerminalPaneSleep(paneKey: string, ptyId: string, incarnationId?: string): boolean {
    const resolved = this.resolvePaneKeyAlias(paneKey)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this server stores enriched accepted rows in the listener's base-typed cache.
    const identity = this.paneAgentIdentity(resolved)
    const previous: EnrichedAgentHookEventPayload | undefined =
      (this.state.lastStatusByPaneKey.get(resolved) as EnrichedAgentHookEventPayload | undefined) ??
      this.getTmuxSelectedStatus(resolved) ??
      (identity
        ? {
            paneKey: resolved,
            tabId: identity.status.tabId,
            worktreeId: identity.status.worktreeId,
            connectionId: identity.status.connectionId,
            receivedAt: identity.status.receivedAt,
            stateStartedAt: identity.status.stateStartedAt,
            providerSession: identity.status.providerSession,
            payload: pickParsedAgentStatusPayload(identity.status)
          }
        : undefined)
    if (
      previous?.paneSleep?.ptyId === ptyId &&
      (!previous.paneSleep.incarnationId ||
        !incarnationId ||
        previous.paneSleep.incarnationId === incarnationId)
    ) {
      return true
    }
    if (this.terminalPaneLifecycle?.ownsProcess(resolved, ptyId, incarnationId) !== true) {
      return false
    }
    if (
      !previous ||
      !identity ||
      identity.ended ||
      this.terminalPaneLifecycle?.isReversibleStop(ptyId, incarnationId) !== true ||
      this.terminalPaneLifecycle.isPlaced(previous) !== true
    ) {
      return false
    }
    const {
      launchToken: _launchToken,
      programStatus: _programStatus,
      programStatusOnly: _programStatusOnly,
      toolUseId: _toolUseId,
      toolAgentId: _toolAgentId,
      terminalHandle: _terminalHandle,
      providerSessionOnly: _providerSessionOnly,
      retainedForLiveness: _retainedForLiveness,
      ...accepted
    } = previous
    const {
      toolName: _toolName,
      toolInput: _toolInput,
      interactivePrompt: _interactivePrompt,
      subagents: _subagents,
      claudeTaskWakeupPending: _wakeup,
      workingMode: _workingMode,
      ...payload
    } = previous.payload
    // Sleep cut an unfinished turn short; that reads Interrupted, never a completion.
    const now = Date.now()
    const midTurn = previous.payload.state !== 'done' && previous.providerSessionOnly !== true
    const row: EnrichedAgentHookEventPayload = {
      ...accepted,
      ...(midTurn ? { stateStartedAt: now } : {}),
      payload: midTurn
        ? {
            ...payload,
            state: 'done',
            interrupted: true,
            ...(payload.mainAgent
              ? {
                  mainAgent: {
                    state: 'done' as const,
                    outcome: 'cancellation' as const,
                    stateStartedAt: now
                  }
                }
              : {})
          }
        : {
            ...payload,
            state: identity.status.state,
            ...(identity.status.sessionBoundary ? { sessionBoundary: true } : {})
          },
      paneSleep: { ptyId, ...(incarnationId ? { incarnationId } : {}) },
      agentPresence: endedPresenceOf(previous)
    }
    if (midTurn) {
      // The cut-off turn's producer records belong to the stopped process.
      clearPaneProcessCacheState(this.state, resolved)
    }
    this.programStatusFacets.delete(resolved)
    this.hookSilenceRechecks.cancel(resolved)
    this.clearTmuxInnerSubjects(resolved)
    if (
      !admitLegacyAgentStatus(
        this.state,
        'main-status-cleanup',
        row,
        AGENT_STATUS_2A_CURRENT_PRODUCER_MODE
      )
    ) {
      return false
    }
    recordAgentExit(this.agentExitedAtByPaneKey, [resolved], row.agentPresence, now)
    this.commitStatusRowMutation(previous, row)
    this.scheduleStatusPersist()
    this.notifyStatusChangeListeners()
    // A lifecycle annotation is not another completed turn.
    this.onAgentStatus?.({ ...row, isReplay: true })
    return true
  }
}
