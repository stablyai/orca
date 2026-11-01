import { hermesResumeSessionId } from '../../shared/hermes-session-id'
import {
  resumeInvocationFromOptions,
  type StructuredAgentSessionHistory
} from '../native-chat/structured-agent-cli-conversations'

export const HERMES_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: ['hermes'],
  rowSessionId: (link) => link.handle.nativeId,
  parseResumeArgs: (args) => {
    const invocation = resumeInvocationFromOptions(args, {
      targetless: ['-c', '--continue'],
      markers: ['-r', '--resume']
    })
    if (!invocation) {
      return null
    }
    // Titles, `latest`, and targetless continue can name any owned session.
    return invocation.target && hermesResumeSessionId(invocation.target) ? invocation : { target: null }
  }
}
