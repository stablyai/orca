import { sessionIdFromFileName } from '../ai-vault/session-scanner-accumulator'
import {
  resumeInvocationFromOptions,
  sessionFileResumeTargetMatches,
  type StructuredAgentSessionHistory
} from '../native-chat/structured-agent-cli-conversations'

export const PI_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: ['pi'],
  // A chat's handle is its session file's path; Session History lists the file by its name's id.
  rowSessionId: (link) => sessionIdFromFileName(link.handle.nativeId),
  // `-r/--resume` opens a picker; `--fork <file>` writes a new session and resumes none.
  parseResumeArgs: (args) =>
    resumeInvocationFromOptions(args, {
      targetless: ['-c', '--continue', '-r', '--resume'],
      markers: ['--session']
    }),
  resumeTargetMatches: sessionFileResumeTargetMatches
}
