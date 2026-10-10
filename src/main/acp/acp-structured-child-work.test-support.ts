import { AgentHookServer } from '../agent-hooks/server'
import type { AgentStatusStructuredSessionSubject } from '../../shared/agent-status-subject'
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
    readChildWork: (subject) => server.getStructuredChildWorkViews(subject)
  }
  return { sink, views: () => (parent ? server.getStructuredChildWorkViews(parent) : []) }
}
