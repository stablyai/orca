import { AgentHookServer } from '../agent-hooks/server'
import type { AgentChildWorkEvidence } from '../../shared/agent-status-child-work-evidence'
import {
  makeStructuredAgentStatusSubject,
  type AgentStatusStructuredSessionSubject
} from '../../shared/agent-status-subject'
import type { StructuredAgentSessionStatusSink } from '../native-chat/agent-session-wire/structured-agent-session-status-ownership'

export function acpChildWorkStatusSink() {
  const server = new AgentHookServer()
  let parent: AgentStatusStructuredSessionSubject | undefined
  const sink: StructuredAgentSessionStatusSink = {
    publish: (summary, subject) => {
      server.ingestStructuredStatus(summary, subject)
      parent = subject
    },
    forget: (subject) => server.dropStructuredStatus(subject),
    publishChildWork: (subject, evidence, provider) =>
      server.ingestStructuredChildWork(subject, evidence, provider),
    readChildWork: (subject) => server.getStructuredChildWorkViews(subject),
    readChildWorkRecords: (subject) => server.getStructuredChildWork(subject),
    readChildWorkHandles: (subject) => server.getStructuredChildWorkHandles(subject)
  }
  return { sink, views: () => (parent ? server.getStructuredChildWorkViews(parent) : []) }
}

/** A host holding one working Grok parent: what a translator reported becomes its child records,
 *  the one authority on each subagent. */
export function acpSubagentRecords() {
  const { sink, views } = acpChildWorkStatusSink()
  const subject = makeStructuredAgentStatusSubject(
    {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'folder'
    },
    'session-timeline'
  )
  sink.publish(
    {
      sessionId: subject.sessionId,
      workspaceId: subject.workspaceId,
      agent: 'grok',
      status: 'working',
      hostExecutionOwned: true,
      latestPrompt: 'Delegate',
      updatedAt: 1
    },
    subject
  )
  return (evidence: AgentChildWorkEvidence[]) => {
    sink.publishChildWork?.(subject, evidence, 'grok')
    return views()
  }
}
