import type { ClaudeSubagentRoster } from '../../../shared/claude-subagent-roster'
import type { ClaudeLeadTurnState } from '../../../shared/agent-hook-listener/main-agent-turn-state'
import type { ToolSnapshot } from '../../../shared/agent-hook-listener/listener-event'
import type { HookListenerState } from '../../../shared/agent-hook-listener/listener-state'
import type { ClaudeTaskTranscriptObservation } from '../../../shared/claude-task-notification-transcript'

type ClaudeIdlePromptSnapshot = {
  roster?: ClaudeSubagentRoster
  lead?: ClaudeLeadTurnState
  prompt?: string
  tool?: ToolSnapshot
  restoredUnconfirmed: boolean
}

export type ClaudeTaskAdmissionSnapshot = {
  runningTask: boolean
  activeCron: boolean
  observations?: Map<string, ClaudeTaskTranscriptObservation>
  unidentifiedTask?: boolean
  idlePrompt?: ClaudeIdlePromptSnapshot
}

export function captureClaudeTaskAdmissionState(
  state: HookListenerState,
  paneKey: string,
  options: { transcript: boolean; idlePrompt: boolean }
): ClaudeTaskAdmissionSnapshot {
  return {
    runningTask: state.claudeRunningNonAgentTaskPaneKeys.has(paneKey),
    activeCron: state.claudeActiveSessionCronPaneKeys.has(paneKey),
    ...(options.transcript
      ? {
          observations: cloneTaskTranscriptObservations(state, paneKey),
          unidentifiedTask:
            state.claudeTaskNotificationState.unidentifiedRunningNonAgentTaskPaneKeys.has(paneKey)
        }
      : {}),
    ...(options.idlePrompt ? { idlePrompt: captureClaudeIdlePromptState(state, paneKey) } : {})
  }
}

export function restoreClaudeTaskAdmissionState(
  state: HookListenerState,
  paneKey: string,
  snapshot: ClaudeTaskAdmissionSnapshot
): void {
  setPaneEvidence(state.claudeRunningNonAgentTaskPaneKeys, paneKey, snapshot.runningTask)
  setPaneEvidence(state.claudeActiveSessionCronPaneKeys, paneKey, snapshot.activeCron)
  if (snapshot.unidentifiedTask !== undefined) {
    setPaneEvidence(
      state.claudeTaskNotificationState.unidentifiedRunningNonAgentTaskPaneKeys,
      paneKey,
      snapshot.unidentifiedTask
    )
    restoreTaskTranscriptObservations(state, paneKey, snapshot.observations)
  }
  if (snapshot.idlePrompt) {
    restoreClaudeIdlePromptState(state, paneKey, snapshot.idlePrompt)
  }
}

function setPaneEvidence(set: Set<string>, paneKey: string, value: boolean): void {
  if (value) {
    set.add(paneKey)
  } else {
    set.delete(paneKey)
  }
}

function cloneTaskTranscriptObservations(
  state: HookListenerState,
  paneKey: string
): Map<string, ClaudeTaskTranscriptObservation> | undefined {
  const observations = state.claudeTaskNotificationState.observationsByPaneKey.get(paneKey)
  return observations ? new Map(observations) : undefined
}

function restoreTaskTranscriptObservations(
  state: HookListenerState,
  paneKey: string,
  observations: Map<string, ClaudeTaskTranscriptObservation> | undefined
): void {
  if (observations && observations.size > 0) {
    state.claudeTaskNotificationState.observationsByPaneKey.set(paneKey, new Map(observations))
  } else {
    state.claudeTaskNotificationState.observationsByPaneKey.delete(paneKey)
  }
}

function captureClaudeIdlePromptState(
  state: HookListenerState,
  paneKey: string
): ClaudeIdlePromptSnapshot {
  const roster = state.claudeSubagentRosterByPaneKey.get(paneKey)
  const lead = state.claudeLeadStateByPaneKey.get(paneKey)
  const tool = state.lastToolByPaneKey.get(paneKey)
  return {
    ...(roster
      ? {
          roster: new Map(Array.from(roster, ([id, tracked]) => [id, { ...tracked }]))
        }
      : {}),
    ...(lead
      ? {
          lead: {
            ...lead,
            ...(lead.stateBeforeWait ? { stateBeforeWait: { ...lead.stateBeforeWait } } : {})
          }
        }
      : {}),
    ...(state.lastPromptByPaneKey.has(paneKey)
      ? { prompt: state.lastPromptByPaneKey.get(paneKey) }
      : {}),
    ...(tool ? { tool: { ...tool } } : {}),
    restoredUnconfirmed: state.claudeUnconfirmedRestoredStatusPaneKeys.has(paneKey)
  }
}

function restoreClaudeIdlePromptState(
  state: HookListenerState,
  paneKey: string,
  snapshot: ClaudeIdlePromptSnapshot
): void {
  if (snapshot.roster) {
    state.claudeSubagentRosterByPaneKey.set(paneKey, new Map(snapshot.roster))
  } else {
    state.claudeSubagentRosterByPaneKey.delete(paneKey)
  }
  if (snapshot.lead) {
    state.claudeLeadStateByPaneKey.set(paneKey, { ...snapshot.lead })
  } else {
    state.claudeLeadStateByPaneKey.delete(paneKey)
  }
  if (snapshot.prompt === undefined) {
    state.lastPromptByPaneKey.delete(paneKey)
  } else {
    state.lastPromptByPaneKey.set(paneKey, snapshot.prompt)
  }
  if (snapshot.tool) {
    state.lastToolByPaneKey.set(paneKey, { ...snapshot.tool })
  } else {
    state.lastToolByPaneKey.delete(paneKey)
  }
  setPaneEvidence(
    state.claudeUnconfirmedRestoredStatusPaneKeys,
    paneKey,
    snapshot.restoredUnconfirmed
  )
}
