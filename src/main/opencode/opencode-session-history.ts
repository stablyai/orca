import {
  ownOptionsInclude,
  resumeInvocationFromOptions,
  type StructuredAgentSessionHistory
} from '../native-chat/structured-agent-cli-conversations'

export const OPENCODE_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: ['opencode', 'opencode2'],
  rowSessionId: (link) => link.handle.nativeId,
  parseResumeArgs: (args) =>
    // `--fork` continues into a new session, so it writes no owned one.
    ownOptionsInclude(args, ['--fork'])
      ? null
      : resumeInvocationFromOptions(args, {
          targetless: ['-c', '--continue'],
          markers: ['-s', '--session']
        })
}
