import type { RemoteAgentInterruptDispatch } from '../../../shared/agent-hook-interrupt-reconciliation'
import {
  markClaudeLeadTurnDone,
  clearClaudeAnsweredQuestionWait
} from '../../../shared/agent-hook-listener/providers/claude-roster-state'
import {
  isAgentInterruptInputIntent,
  isNavigationEscapeIntent,
  requiresDoubleEscapeInterrupt,
  shouldIgnoreInterruptIntent,
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
import {
  ClaudeTerminalInterruptTracker,
  type ClaudeTerminalEvidence
} from '../../../shared/claude-terminal-interrupt'

export abstract class AgentHookServerStatusInference extends AgentHookServerRowOwnership {
  private remoteInterruptListeners = new Set<(command: RemoteAgentInterruptDispatch) => void>()

  subscribeRemoteInterruptRequests(
    listener: (command: RemoteAgentInterruptDispatch) => void
  ): () => void {
    this.remoteInterruptListeners.add(listener)
    return () => this.remoteInterruptListeners.delete(listener)
  }

  private readonly claudeTerminalInterrupts = new ClaudeTerminalInterruptTracker(
    (paneKey) => {
      const row = this.state.lastStatusByPaneKey.get(paneKey)
      // Remote evidence is adjudicated by the relay that owns its input and live output.
      return row?.connectionId ? undefined : row
    },
    (row) => {
      if (
        !('receivedAt' in row) ||
        typeof row.receivedAt !== 'number' ||
        !('stateStartedAt' in row) ||
        typeof row.stateStartedAt !== 'number'
      ) {
        return
      }
      this.applyInterruptInference(
        {
          paneKey: row.paneKey,
          intent: 'plain-escape',
          baselineUpdatedAt: row.receivedAt,
          baselineStateStartedAt: row.stateStartedAt,
          baselinePrompt: row.payload.prompt,
          baselineAgentType: 'claude'
        },
        true
      )
    }
  )

  observeClaudeTerminalEvidence(paneKey: string, evidence: ClaudeTerminalEvidence): void {
    if (evidence.kind === 'input') {
      this.programStatusFacets.noteInput(paneKey)
    }
    this.claudeTerminalInterrupts.observe(paneKey, evidence)
  }

  inferInterrupt(request: AgentInterruptInferenceRequest): boolean {
    return this.applyInterruptInference(request, false)
  }

  private applyInterruptInference(
    request: AgentInterruptInferenceRequest,
    claudeNativeTitleConfirmed: boolean
  ): boolean {
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
    // Restored work needs live confirmation before inference can settle it.
    if (existing.restoredUnconfirmed) {
      return false
    }
    const payload = existing.payload
    const agentType: AgentType | undefined = payload.agentType
    if (shouldIgnoreInterruptIntent(agentType, request.intent)) {
      return false
    }
    // These TUIs use one Escape for navigation; only a double Escape proves cancel intent.
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
    // Match the baseline so delayed inference cannot overwrite a newer hook.
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
    // Enforce navigation exclusions here too; direct requests can bypass the renderer.
    if (
      isNavigationEscapeIntent(agentType, request.intent) &&
      !(agentType === 'claude' && claudeNativeTitleConfirmed)
    ) {
      return false
    }
    const childWorkEvidenced =
      payload.subagents?.some((subagent) => subagent.state !== 'idle') === true ||
      (agentType === 'claude' &&
        (this.state.claudeRunningNonAgentTaskPaneKeys.has(existing.paneKey) ||
          this.state.claudeActiveSessionCronPaneKeys.has(existing.paneKey)))
    // Ctrl+C at an idle main prompt cannot cancel child work; older peers use the child-evidence guard.
    if (payload.mainAgent ? payload.mainAgent.state !== 'working' : childWorkEvidenced) {
      return false
    }
    const inferred = this.settleTurnWithoutStop(existing, 'cancellation')
    if (!inferred) {
      return false
    }
    if (
      agentType === 'claude' &&
      request.intent === 'ctrl-c' &&
      existing.connectionId &&
      existing.hostTurnRevision &&
      existing.providerSession
    ) {
      const command: RemoteAgentInterruptDispatch = {
        connectionId: existing.connectionId,
        request: {
          paneKey: existing.paneKey,
          hostTurnRevision: existing.hostTurnRevision,
          launchToken: existing.launchToken,
          providerSession: existing.providerSession,
          intent: 'ctrl-c'
        }
      }
      for (const listener of this.remoteInterruptListeners) {
        try {
          listener(command)
        } catch (error) {
          console.warn('[agent-hooks] remote interrupt dispatch failed', error)
        }
      }
    }
    console.debug('[agent-hooks] inferred interrupted agent status', {
      paneKey: inferred.paneKey,
      agentType,
      intent: request.intent
    })
    return true
  }

  /** A prompt hook blocked Claude's prompt (its claimed run rested with no result), so no Stop follows. */
  protected settleClaudePromptBlocked(row: EnrichedAgentHookEventPayload): void {
    if (
      this.programStatusFacets.claimedRunRestedWithoutResult(row.paneKey, 'claude') &&
      // Relayed interrupts are adjudicated on the relay, which sees the input this host does not.
      !row.connectionId &&
      this.state.lastStatusByPaneKey.get(row.paneKey) === row &&
      row.payload.agentType === 'claude' &&
      row.payload.mainAgent?.state === 'working' &&
      !row.restoredUnconfirmed &&
      !row.providerSessionOnly
    ) {
      this.settleTurnWithoutStop(row)
    }
  }

  /** End a working main-agent turn whose Stop hook never comes; cancellation marks an interrupt. */
  private settleTurnWithoutStop(
    existing: EnrichedAgentHookEventPayload,
    outcome?: 'cancellation'
  ): EnrichedAgentHookEventPayload | undefined {
    const { payload } = existing
    const agentType = payload.agentType
    // Update local producer records too, or later child hooks revive stale work; remote records belong to the relay.
    const local =
      agentType === 'claude' && !existing.connectionId
        ? markClaudeLeadTurnDone(this.state, existing.paneKey, outcome)
        : undefined
    const relayed =
      agentType === 'claude' && existing.connectionId
        ? foldMainAgentWithRowChildWork('done', existing)
        : undefined
    const state = local?.state ?? relayed?.stateName ?? 'done'
    const workingMode = local?.workingMode ?? relayed?.workingMode
    return this.applyNormalizedStatus({
      paneKey: existing.paneKey,
      tabId: existing.tabId,
      worktreeId: existing.worktreeId,
      connectionId: existing.connectionId,
      providerSession: existing.providerSession,
      launchToken: existing.launchToken,
      hostTurnRevision: existing.hostTurnRevision,
      source: existing.source,
      // Retain shell evidence so restart can seed the cancelled main agent and later settle drained children.
      ...(existing.claudeRunningNonAgentTask !== undefined
        ? { claudeRunningNonAgentTask: existing.claudeRunningNonAgentTask }
        : {}),
      payload: {
        state,
        claudeTaskWakeupPending:
          state !== 'done'
            ? local
              ? local.claudeTaskWakeupPending
              : payload.claudeTaskWakeupPending
            : undefined,
        ...(workingMode ? { workingMode } : {}),
        prompt: payload.prompt,
        agentType,
        ...(payload.model ? { model: payload.model } : {}),
        // Older readers use interrupted on done rows; monitoring rows keep cancellation on mainAgent.outcome.
        ...(state === 'done' && outcome ? { interrupted: true } : {}),
        // Idle children remain display state across inferred cancellation.
        ...(payload.subagents ? { subagents: payload.subagents } : {}),
        mainAgent: local?.mainAgent ?? {
          state: 'done',
          ...(outcome ? { outcome } : {}),
          stateStartedAt: Date.now()
        }
      }
    })
  }

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
    const inferred = this.applyNormalizedStatus({
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
