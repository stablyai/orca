import type { ClaudeStatusLineModel } from '../../../shared/agent-hook-listener/providers/claude/lifecycle/claude-statusline-model'
import { retainClaudeLeadModel } from '../../../shared/agent-hook-listener/providers/claude/lifecycle/claude-roster-state'
import type { EnrichedAgentHookEventPayload } from './server-types'
import { AgentHookServerStatusHookLifecycle } from './server-status-hook-lifecycle'

export abstract class AgentHookServerClaudeStatusLineModel extends AgentHookServerStatusHookLifecycle {
  /** Claude hooks name the model only at SessionStart; its statusline follows a later /model switch. */
  protected applyClaudeStatusLineModel(report: ClaudeStatusLineModel): void {
    const paneKey = this.resolvePaneKeyAlias(report.paneKey)
    const lead = this.state.claudeLeadStateByPaneKey.get(paneKey)
    // Another session's statusline must not relabel the conversation that owns the pane.
    if (!lead || this.state.claudeSessionOwnerByPaneKey.get(paneKey) !== report.sessionId) {
      return
    }
    retainClaudeLeadModel(this.state, paneKey, report.model)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Main admits enriched legacy rows; the shared view declares their base event type.
    const previous = this.state.lastStatusByPaneKey.get(paneKey) as
      | EnrichedAgentHookEventPayload
      | undefined
    if (previous?.payload.agentType !== 'claude' || previous.payload.model === report.model) {
      return
    }
    // Only the label changes: the row keeps its state and clocks, so no transition is reported.
    const updated = { ...previous, payload: { ...previous.payload, model: report.model } }
    if (!this.writeLegacyStatusRow(updated)) {
      return
    }
    this.commitStatusRowMutation(previous, updated)
    this.scheduleStatusPersist()
    this.emitEnrichedStatus(updated)
  }
}
