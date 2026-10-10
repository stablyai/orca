import {
  ownOptionsInclude,
  resumeInvocationFromOptions,
  type StructuredAgentSessionHistory
} from '../native-chat/structured-agent-cli-conversations'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const GROK_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: ['grok'],
  rowSessionId: (link) => link.handle.nativeId,
  parseResumeArgs: (args) => {
    // `--fork-session` resumes into a new session id, so it writes no owned one.
    if (ownOptionsInclude(args, ['--fork-session'])) {
      return null
    }
    const invocation = resumeInvocationFromOptions(args, {
      targetless: ['-c', '--continue'],
      markers: ['-r', '--resume', '--load']
    })
    // Grok reads a non-UUID value as a session title, which may name any of the folder's sessions.
    return invocation?.target && !UUID.test(invocation.target) ? { target: null } : invocation
  },
  resumeTargetMatches: (target, rowSessionId) => target.toLowerCase() === rowSessionId.toLowerCase()
}
