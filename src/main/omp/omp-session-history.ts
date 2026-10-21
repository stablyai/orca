import {
  resumeInvocationFromOptions,
  sessionFileResumeTargetMatches,
  type StructuredAgentSessionHistory
} from '../native-chat/structured-agent-cli-conversations'

/** A chat's ACP session id is its session file's header id, which Session History lists it under. */
export const OMP_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: ['omp'],
  rowSessionId: (link) => link.handle.nativeId,
  // A bare `--resume` opens the picker; `--fork <session>` writes a new session and resumes none.
  parseResumeArgs: (args) =>
    resumeInvocationFromOptions(args, {
      targetless: ['-c', '--continue'],
      markers: ['-r', '--resume', '--session']
    }),
  resumeTargetMatches: sessionFileResumeTargetMatches
}
