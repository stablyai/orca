import {
  claudeRosterHasRestoredSnapshotSubagent,
  claudeRosterHasWorkingSubagent,
  claudeRosterToSnapshots
} from '../../../shared/claude-subagent-roster'
import { reapRestoredClaudeSubagentsForDeadPane } from '../../../shared/agent-hook-listener/providers/claude-roster-state'
import { AgentHookServerTabCleanup } from './server-tab-cleanup'
import type { EnrichedAgentHookEventPayload } from './server-types'

export abstract class AgentHookServerReaping extends AgentHookServerTabCleanup {
  /** Second reap path for restored Claude subagent rows: drop the ones whose pane
   *  has no live local agent process behind it any more. A PTY that dies while Orca
   *  is down never runs the teardown that clears pane state, so hydrate rebuilds a
   *  roster nothing can ever retire — the inventory reap needs the parent to emit a
   *  complete `background_tasks` list and an idle parent never does. The row then
   *  gates the pane 'working' for the rest of its life and hibernation, which
   *  requires 'done', can never reclaim the agent's heap.
   *
   *  Both the execution host and relay binding must prove local ownership before
   *  targeted PTY liveness is consulted. Panes that reported in this runtime are
   *  also skipped. Returns the number of panes changed. */
  async reapRestoredClaudeSubagentsWithoutLiveAgent(
    isLocalExecutionHost: (worktreeId: string | undefined) => boolean,
    isLocalPaneAgentLive: (paneKey: string) => Promise<boolean>,
    isLocalPaneLivenessEvidenceCurrent: (paneKey: string) => boolean
  ): Promise<number> {
    const candidates: { paneKey: string; entry: EnrichedAgentHookEventPayload }[] = []
    for (const [paneKey, entry] of this.state.lastStatusByPaneKey) {
      const enriched = entry as EnrichedAgentHookEventPayload
      if (
        enriched.payload.agentType === 'claude' &&
        enriched.connectionId === null &&
        isLocalExecutionHost(enriched.worktreeId) &&
        // Why: a restored roster is only one shape of stranded claim. A lead row left non-terminal,
        // or a background-task/cron latch nothing will refresh, strands the pane just as
        // permanently — and unlike the roster case there is no child event left to reap it.
        (claudeRosterHasRestoredSnapshotSubagent(
          this.state.claudeSubagentRosterByPaneKey.get(paneKey)
        ) ||
          enriched.payload.state !== 'done' ||
          this.state.claudeRunningNonAgentTaskPaneKeys.has(paneKey) ||
          this.state.claudeActiveSessionCronPaneKeys.has(paneKey)) &&
        !this.runtimeObservedStatusPaneKeys.has(paneKey)
      ) {
        candidates.push({ paneKey, entry: enriched })
      }
    }
    const liveness = await Promise.all(
      candidates.map(async (candidate) => {
        try {
          return await isLocalPaneAgentLive(candidate.paneKey)
        } catch {
          return true
        }
      })
    )
    let changedPanes = 0
    for (const [index, candidate] of candidates.entries()) {
      const { paneKey, entry: enriched } = candidate
      if (
        liveness[index] ||
        !isLocalPaneLivenessEvidenceCurrent(paneKey) ||
        this.state.lastStatusByPaneKey.get(paneKey) !== enriched ||
        this.runtimeObservedStatusPaneKeys.has(paneKey) ||
        !isLocalExecutionHost(enriched.worktreeId)
      ) {
        continue
      }
      if (!reapRestoredClaudeSubagentsForDeadPane(this.state, paneKey)) {
        // Why: the roster reap only speaks for restored child rows. A pane whose PTY is provably
        // gone and whose claim is a lead row or a latch has nothing for it to reap, so retire the
        // pane the same way an observed exit would — otherwise the widened candidate set is inert.
        //
        // Why delete rather than downgrade to `done` like the reap branch below: that branch has a
        // real turn to describe — a parent whose children it just reaped — while these panes' only
        // claim IS the stale non-terminal row. Rewriting a `waiting`/`blocked` row to `done` would
        // invent a completion that never happened, and leaving it non-terminal keeps the bug. This
        // sweep stands in for the exit Orca never observed, so it does what that exit does:
        // `clearProviderPtyState` -> `clearPaneState`.
        if (this.hasLiveClaimsForPaneKey(paneKey)) {
          this.clearPaneState(paneKey)
          changedPanes += 1
        }
        continue
      }
      changedPanes += 1
      const roster = this.state.claudeSubagentRosterByPaneKey.get(paneKey)
      const subagents = claudeRosterToSnapshots(roster)
      // Why: the pane's persisted 'working' was the child gate holding a finished
      // lead open (subagent events never set lead state). With the last working row
      // gone and no process left to report, 'done' is the only truthful state — and
      // the one hibernation needs once this pane's agent is restored.
      const state =
        enriched.payload.state === 'working' && !claudeRosterHasWorkingSubagent(roster)
          ? 'done'
          : enriched.payload.state
      const stateChanged = state !== enriched.payload.state
      const reconciledAt = stateChanged
        ? Math.max(Date.now(), enriched.receivedAt + 1)
        : enriched.receivedAt
      // Why: a reconciled `done` is process-probe-verified, not hydrated guesswork — carrying
      // restoredUnconfirmed onto it would make freshness gates suppress a legitimate completion.
      const { restoredUnconfirmed, ...reconciledBase } = enriched
      const reconciled: EnrichedAgentHookEventPayload = {
        ...reconciledBase,
        ...(state !== 'done' && restoredUnconfirmed ? { restoredUnconfirmed: true } : {}),
        receivedAt: reconciledAt,
        stateStartedAt: stateChanged ? reconciledAt : enriched.stateStartedAt,
        payload: {
          ...enriched.payload,
          state,
          workingMode: state === 'working' ? enriched.payload.workingMode : undefined,
          subagents
        }
      }
      this.state.lastStatusByPaneKey.set(paneKey, reconciled)
    }
    if (changedPanes > 0) {
      this.scheduleStatusPersist()
      this.notifyStatusChangeListeners()
    }
    return changedPanes
  }
}
