import type { AgentSessionProviderHandleLink } from '../../shared/agent-session-provider-handle'
import {
  resumeInvocationFromOptions,
  type StructuredAgentSessionHistory
} from '../native-chat/structured-agent-cli-conversations'

export const MUSE_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: ['muse'],
  // A chat's handle is its MSP session id.
  rowSessionId: (link: AgentSessionProviderHandleLink) => link.handle.nativeId,
  // `muse resume [<session-ref>]` reopens that session; `muse resume --last`
  // reopens whatever ran last.
  parseResumeArgs: (args) =>
    resumeInvocationFromOptions(args, { targetless: ['--last'], markers: ['resume'] }),
  resumeTargetMatches: (target, rowSessionId) =>
    rowSessionId.toLowerCase().startsWith(target.toLowerCase())
}
