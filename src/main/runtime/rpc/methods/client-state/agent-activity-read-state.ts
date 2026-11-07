import {
  agentActivityReadState,
  changeAgentActivityReadState,
  type AgentActivitySubject
} from '../../../../../shared/agent-activity-read-state'
import { SetAgentActivityReadStateParams } from '../../../../../shared/rpc-contract/agent-activity-read-params'
import type { PersistedUIState } from '../../../../../shared/persisted-ui-state-types'
import { defineMethod } from '../../core'
import type { z } from 'zod'

type ActivityRuntime = {
  getAgentActivitySubjects(): readonly AgentActivitySubject[] | null
  getUIState(): PersistedUIState
  updateUIState(updates: Partial<PersistedUIState>): PersistedUIState
}

function unambiguousSubjects(subjects: readonly AgentActivitySubject[]): AgentActivitySubject[] {
  const counts = new Map<string, number>()
  for (const subject of subjects) {
    counts.set(subject.paneKey, (counts.get(subject.paneKey) ?? 0) + 1)
  }
  return subjects.filter((subject) => counts.get(subject.paneKey) === 1)
}

export function readAgentActivities(runtime: ActivityRuntime) {
  const subjects = runtime.getAgentActivitySubjects()
  return {
    available: subjects !== null,
    activities:
      subjects === null
        ? []
        : unambiguousSubjects(subjects).map((subject) =>
            agentActivityReadState(subject, runtime.getUIState())
          )
  }
}

export function setAgentActivityRead(
  runtime: ActivityRuntime,
  params: z.infer<typeof SetAgentActivityReadStateParams>
) {
  const subjects = runtime.getAgentActivitySubjects()
  const subject =
    subjects &&
    unambiguousSubjects(subjects).find(
      (entry) =>
        entry.paneKey === params.paneKey &&
        entry.worktreeId === params.worktreeId &&
        entry.hostId === params.hostId
    )
  if (!subject) {
    throw new Error('activity_read_state_unavailable')
  }
  const updates = changeAgentActivityReadState(
    runtime.getUIState(),
    subject,
    params.read,
    params.latestActivityAt
  )
  return agentActivityReadState(subject, runtime.updateUIState(updates))
}

export const AGENT_ACTIVITY_READ_METHODS = [
  defineMethod({
    name: 'ui.getAgentActivityReadState',
    permission: 'workspace',
    params: null,
    handler: (_params, { runtime }) => readAgentActivities(runtime)
  }),
  defineMethod({
    name: 'ui.setAgentActivityReadState',
    permission: 'workspace',
    params: SetAgentActivityReadStateParams,
    handler: (params, { runtime }) => setAgentActivityRead(runtime, params)
  })
]
