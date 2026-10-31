import { computeAgentSessionPayloadFingerprint } from '../../../../shared/agent-session-mutation-envelope'
import type { AgentSessionMutationEnvelope } from '../../../../shared/agent-session-wire'
import type {
  StructuredAgentSessionResumeSource,
  StructuredAgentSessionFirstMessage
} from '../../../../shared/structured-agent-session-create'

export function structuredAgentSessionCreateIntentFingerprint(params: {
  envelope: AgentSessionMutationEnvelope
  worktree: string
  agent: string
  resumeFrom?: StructuredAgentSessionResumeSource
  tabId?: string
  firstMessage?: StructuredAgentSessionFirstMessage
  optionsMode?: 'replace-model-selection'
  options?: Readonly<Record<string, string>>
}): string {
  return computeAgentSessionPayloadFingerprint({
    method: 'agentSession.create',
    sessionId: params.envelope.sessionId,
    fields: {
      worktree: params.worktree,
      agent: params.agent,
      resumeFrom: params.resumeFrom,
      tabId: params.tabId,
      firstMessage: params.firstMessage,
      optionsMode: params.optionsMode,
      options: params.options
    }
  })
}

export { seededPermissionMode } from '../../../../shared/native-chat/input/native-chat-session-option-defaults'
