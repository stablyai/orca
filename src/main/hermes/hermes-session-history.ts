import {
  resumeInvocationFromOptions,
  type StructuredAgentSessionHistory
} from '../native-chat/structured-agent-cli-conversations'

const TIMESTAMP_SESSION_ID = /^\d{8}_\d{6}_[0-9a-f]+$/i
const UUID_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isHermesSessionId(target: string): boolean {
  return TIMESTAMP_SESSION_ID.test(target) || UUID_SESSION_ID.test(target)
}

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
    return invocation.target && isHermesSessionId(invocation.target) ? invocation : { target: null }
  }
}
