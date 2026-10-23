import {
  ownOptionsInclude,
  resumeInvocationFromOptions,
  type StructuredAgentSessionHistory
} from '../native-chat/structured-agent-cli-conversations'

/** OpenCode 2.x lists a conversation as an `opencode2` row, 1.x as `opencode`, both under the
 *  `ses_` id the chat's ACP session carries. */
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
