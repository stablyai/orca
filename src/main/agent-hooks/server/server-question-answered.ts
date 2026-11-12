import { clearClaudeAnsweredQuestionWait } from '../../../shared/agent-hook-listener/providers/claude-roster-state'

import {
  isAskUserQuestionTool,
  type AgentQuestionAnsweredInferenceRequest
} from '../../../shared/agent-status/lifecycle/agent-question-answered-intent'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../shared/agent-status/contracts/agent-status-freshness'

import type { EnrichedAgentHookEventPayload } from './server-types'
import { isValidPaneKey } from './server-status-identity'
import { AgentHookServerRowOwnership } from './server-row-ownership'

export abstract class AgentHookServerQuestionAnswered extends AgentHookServerRowOwnership {
  /** Claude can omit the final hook after AskUserQuestion is answered or dismissed. */
  inferQuestionAnswered(request: AgentQuestionAnsweredInferenceRequest): boolean {
    if (!isValidPaneKey(request.paneKey)) {
      return false
    }
    const existing = this.state.lastStatusByPaneKey.get(request.paneKey) as
      | EnrichedAgentHookEventPayload
      | undefined
    if (!existing) {
      return false
    }
    // Restored waits need live confirmation before inference can clear them.
    if (existing.restoredUnconfirmed) {
      return false
    }
    const payload = existing.payload
    // AskUserQuestion clears on input; actual permission waits remain sticky.
    if (
      payload.agentType !== 'claude' ||
      payload.state !== 'waiting' ||
      !isAskUserQuestionTool(payload.toolName)
    ) {
      return false
    }
    if (
      payload.agentType !== request.baselineAgentType ||
      payload.prompt !== request.baselinePrompt ||
      existing.receivedAt !== request.baselineUpdatedAt ||
      existing.stateStartedAt !== request.baselineStateStartedAt ||
      Date.now() - existing.receivedAt > AGENT_STATUS_STALE_AFTER_MS
    ) {
      return false
    }
    // Update the producer too so later child hooks cannot resurrect the answered question.
    const restored = clearClaudeAnsweredQuestionWait(this.state, existing.paneKey)
    const inferred = this.applyRestatedStatus({
      paneKey: existing.paneKey,
      tabId: existing.tabId,
      worktreeId: existing.worktreeId,
      connectionId: existing.connectionId,
      providerSession: existing.providerSession,
      launchToken: existing.launchToken,
      hostTurnRevision: existing.hostTurnRevision,
      source: existing.source,
      payload: {
        state: restored.state,
        claudeTaskWakeupPending:
          restored.state !== 'done'
            ? existing.connectionId
              ? payload.claudeTaskWakeupPending
              : restored.claudeTaskWakeupPending
            : undefined,
        ...(restored.workingMode ? { workingMode: restored.workingMode } : {}),
        prompt: payload.prompt,
        agentType: payload.agentType,
        ...(restored.state === 'done' && restored.interrupted ? { interrupted: true } : {}),
        ...(restored.turnCompletedAt !== undefined
          ? { turnCompletedAt: restored.turnCompletedAt }
          : {}),
        ...(payload.subagents ? { subagents: payload.subagents } : {}),
        mainAgent: restored.mainAgent
      }
    })
    if (!inferred) {
      return false
    }
    console.debug('[agent-hooks] inferred resolved question status', {
      paneKey: inferred.paneKey,
      state: inferred.payload.state
    })
    return true
  }
}
