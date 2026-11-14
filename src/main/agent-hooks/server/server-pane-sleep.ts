import { admitLegacyAgentStatus } from '../../../shared/agent-hook-listener/listener-state'

import { AGENT_STATUS_2A_CURRENT_PRODUCER_MODE } from '../../../shared/agent-status/transport/agent-status-legacy-adapter'

import type { EnrichedAgentHookEventPayload } from './server-types'
import { AgentHookServerAuthorityFences } from './server-authority-fences'
import { recordAgentExit } from './agent-exit-evidence'

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

  retireSleepingPaneOnSpawn(paneKey: string): void {
    const row = this.state.lastStatusByPaneKey.get(paneKey) as
      | EnrichedAgentHookEventPayload
      | undefined
    if (row?.paneSleep) {
      this.dropStatusEntry(paneKey, { preserveResumeIdentity: false })
      this.emitPaneStatusCleared({ paneKey })
    }
  }

  /** The physical stop changes presence, never the accepted completion or its clocks. */
  settleTerminalPaneSleep(paneKey: string, ptyId: string, incarnationId?: string): boolean {
    const resolved = this.resolvePaneKeyAlias(paneKey)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this server stores enriched accepted rows in the listener's base-typed cache.
    const previous = this.state.lastStatusByPaneKey.get(resolved) as
      | EnrichedAgentHookEventPayload
      | undefined
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
      previous.payload.state !== 'done' ||
      previous.payload.sessionBoundary === true ||
      previous.providerSessionOnly ||
      previous.structuredHost ||
      previous.observation?.origin === 'launch' ||
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
      ...accepted
    } = previous
    const {
      toolName: _toolName,
      toolInput: _toolInput,
      interactivePrompt: _interactivePrompt,
      subagents: _subagents,
      claudeTaskWakeupPending: _wakeup,
      ...payload
    } = previous.payload
    const row: EnrichedAgentHookEventPayload = {
      ...accepted,
      payload,
      paneSleep: { ptyId, ...(incarnationId ? { incarnationId } : {}) },
      agentPresence: {
        agent: previous.payload.agentType ?? 'unknown',
        ...previous.agentPresence,
        ended: true
      }
    }
    this.programStatusFacets.delete(resolved)
    this.hookSilenceRechecks.cancel(resolved)
    admitLegacyAgentStatus(
      this.state,
      'main-status-cleanup',
      row,
      AGENT_STATUS_2A_CURRENT_PRODUCER_MODE
    )
    recordAgentExit(this.agentExitedAtByPaneKey, [resolved], row.agentPresence)
    this.commitStatusRowMutation(previous, row)
    this.scheduleStatusPersist()
    this.notifyStatusChangeListeners()
    // A lifecycle annotation is not another completed turn.
    this.onAgentStatus?.({ ...row, isReplay: true })
    return true
  }
}
