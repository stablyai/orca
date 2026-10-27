import { sessionIdFromFileName } from '../ai-vault/session-scanner-accumulator'
import {
  resumeInvocationFromOptions,
  sessionFileResumeTargetMatches,
  type StructuredAgentSessionHistory
} from '../native-chat/structured-agent-cli-conversations'

export const PI_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: ['pi'],
  // Chat handles name the file path; Session History rows use its filename ID.
  rowSessionId: (link) => sessionIdFromFileName(link.handle.nativeId),
  // --resume opens a picker; --session-id reopens an ID; --fork creates a new session.
  parseResumeArgs: (args) =>
    resumeInvocationFromOptions(args, {
      targetless: ['-c', '--continue', '-r', '--resume'],
      markers: ['--session', '--session-id']
    }),
  resumeTargetMatches: sessionFileResumeTargetMatches
}
