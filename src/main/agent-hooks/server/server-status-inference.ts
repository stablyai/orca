import {
  markClaudeLeadTurnInterrupted,
  clearClaudeAnsweredQuestionWait
} from '../../../shared/agent-hook-listener/providers/claude-roster-state'
import {
  markCodexLeadTurnInterrupted,
  seedCodexStateFromSnapshot
} from '../../../shared/agent-hook-listener/providers/codex-state'
import {
  isAgentInterruptInputIntent,
  isNavigationEscapeIntent,
  requiresDoubleEscapeInterrupt,
  type AgentInterruptInferenceRequest
} from '../../../shared/agent-interrupt-intent'
import {
  isAskUserQuestionTool,
  type AgentQuestionAnsweredInferenceRequest
} from '../../../shared/agent-question-answered-intent'
import { AGENT_STATUS_STALE_AFTER_MS, type AgentType } from '../../../shared/agent-status-types'
import type { EnrichedAgentHookEventPayload } from './server-types'
import { equivalentInterruptAgentType, isValidPaneKey } from './server-status-identity'
import { AgentHookServerRowOwnership } from './server-row-ownership'
import { foldMainAgentWithRowChildWork } from './server-row-child-work-fold'

export abstract class AgentHookServerStatusInference extends AgentHookServerRowOwnership {
  inferInterrupt(request: AgentInterruptInferenceRequest): boolean {
    if (!isValidPaneKey(request.paneKey)) {
      return false
    }
    if (!isAgentInterruptInputIntent(request.intent)) {
      return false
    }
    const existing = this.state.lastStatusByPaneKey.get(request.paneKey) as
      | EnrichedAgentHookEventPayload
      | undefined
    if (!existing) {
      return false
    }
    if (existing.providerSessionOnly) {
      return false
    }
    // Why: inference must not fabricate a `done` onto a row whose `working` was never confirmed this runtime.
    if (existing.restoredUnconfirmed) {
      return false
    }
    const payload = existing.payload
    const agentType: AgentType | undefined = payload.agentType
    // Why: Droid's Ctrl+C exits the CLI (handled by PTY lifecycle) rather than interrupting the current turn.
    if (agentType === 'droid' && request.intent === 'ctrl-c') {
      return false
    }
    // Why: these agents use the first Escape as a TUI cancel that can leave the turn running; only a double Escape infers an interrupt.
    if (requiresDoubleEscapeInterrupt(agentType, request.intent) && request.inputCount !== 2) {
      return false
    }
    const dismissesClaudeQuestion =
      agentType === 'claude' &&
      request.intent === 'plain-escape' &&
      payload.state === 'waiting' &&
      isAskUserQuestionTool(payload.toolName)
    if (dismissesClaudeQuestion) {
      return this.inferQuestionAnswered(request)
    }
    // Why: inference is a fallback for a missing final hook; a strict baseline match keeps a delayed timer from clobbering any newer hook.
    if (
      payload.state !== 'working' ||
      !equivalentInterruptAgentType(agentType, request.baselineAgentType) ||
      payload.prompt !== request.baselinePrompt ||
      existing.receivedAt !== request.baselineUpdatedAt ||
      existing.stateStartedAt !== request.baselineStateStartedAt ||
      Date.now() - existing.receivedAt > AGENT_STATUS_STALE_AFTER_MS
    ) {
      return false
    }
    // Why: re-checked here, not only in the renderer, so a stale or direct inference request
    // cannot route around the renderer's skip and synthesize a false stopped row.
    if (isNavigationEscapeIntent(agentType, request.intent)) {
      return false
    }
    const childWorkEvidenced =
      payload.subagents?.some((subagent) => subagent.state !== 'idle') === true ||
      (agentType === 'claude' &&
        (this.state.claudeRunningNonAgentTaskPaneKeys.has(existing.paneKey) ||
          this.state.claudeActiveSessionCronPaneKeys.has(existing.paneKey)))
    // Why: a 'working' pane can be child-driven, and Ctrl+C at the idle prompt of a main agent that
    // child work holds open cancels nothing, so the main agent fact decides. A row from a host too
    // old to publish `mainAgent` keeps the evidence guard.
    if (payload.mainAgent ? payload.mainAgent.state !== 'working' : childWorkEvidenced) {
      return false
    }
    // Why: whoever owns the provider records folds the cancel with the child work the turn left
    // running. A local pane's listener record must learn it too, or a later child event re-emits
    // the stale 'working' state. Claude's relayed records live on the relay, so its row is the only
    // evidence there; Codex folds through main's own lead/roster cache for both, because relayed
    // Codex rows are already reconciled against it (reconcileRemoteCodexState).
    if (agentType === 'codex') {
      // Why: a relayed row that never carried a hook event name is not reconciled into main's
      // cache; the same seed reconcile uses keeps its children from being retired by the fold.
      seedCodexStateFromSnapshot(this.state, existing.paneKey, payload)
    }
    const recordFolded =
      agentType === 'claude' && !existing.connectionId
        ? markClaudeLeadTurnInterrupted(this.state, existing.paneKey)
        : agentType === 'codex'
          ? markCodexLeadTurnInterrupted(this.state, existing.paneKey)
          : undefined
    const rowFolded =
      agentType === 'claude' && existing.connectionId
        ? foldMainAgentWithRowChildWork('done', existing)
        : undefined
    const state = recordFolded?.state ?? rowFolded?.stateName ?? 'done'
    const workingMode = recordFolded?.workingMode ?? rowFolded?.workingMode
    const inferred = this.applyNormalizedStatus({
      paneKey: existing.paneKey,
      tabId: existing.tabId,
      worktreeId: existing.worktreeId,
      connectionId: existing.connectionId,
      providerSession: existing.providerSession,
      // Why: a cancel leaves the shell fact as it was; dropping it would stop restart from seeding
      // the cancelled main agent, so a child's later drain could never settle the row.
      ...(existing.claudeRunningNonAgentTask !== undefined
        ? { claudeRunningNonAgentTask: existing.claudeRunningNonAgentTask }
        : {}),
      payload: {
        state,
        ...(workingMode ? { workingMode } : {}),
        prompt: payload.prompt,
        agentType,
        ...(payload.model ? { model: payload.model } : {}),
        // Why: `interrupted` is the settled row's restatement of the verdict for readers that
        // predate `mainAgent`; a row the cancel left monitoring carries it on `mainAgent.outcome` only.
        ...(state === 'done' ? { interrupted: true } : {}),
        // Why: idle children are display state; dropping them on an inferred interrupt blanks rows a later hook would restore.
        ...(payload.subagents ? { subagents: payload.subagents } : {}),
        mainAgent: recordFolded?.mainAgent ?? {
          state: 'done',
          outcome: 'cancellation',
          stateStartedAt: Date.now()
        }
      }
    })
    if (!inferred) {
      return false
    }
    console.debug('[agent-hooks] inferred interrupted agent status', {
      paneKey: inferred.paneKey,
      agentType,
      intent: request.intent
    })
    return true
  }

  /** Guarded fallback for the hook Claude omits after answering or dismissing AskUserQuestion. */
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
    // Why: inference must not fabricate a transition onto a row whose state was never confirmed this runtime.
    if (existing.restoredUnconfirmed) {
      return false
    }
    const payload = existing.payload
    // Why: only Claude's interactive question clears on typed input — tool name (not hook event) discriminates; real permission waits stay sticky.
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
    // Why: sync the listener's lead-turn record too, or a later child event re-emits the stale waiting state and resurrects the card.
    const restored = clearClaudeAnsweredQuestionWait(this.state, existing.paneKey)
    const inferred = this.applyNormalizedStatus({
      paneKey: existing.paneKey,
      tabId: existing.tabId,
      worktreeId: existing.worktreeId,
      connectionId: existing.connectionId,
      providerSession: existing.providerSession,
      payload: {
        state: restored.state,
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
