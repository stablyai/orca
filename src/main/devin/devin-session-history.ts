import {
  resumeInvocationFromOptions,
  type StructuredAgentSessionHistory
} from '../native-chat/structured-agent-cli-conversations'

export const DEVIN_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: ['devin'],
  rowSessionId: (link) => link.handle.nativeId,
  // A bare `--resume` opens the picker.
  parseResumeArgs: (args) =>
    resumeInvocationFromOptions(args, {
      targetless: ['-c', '--continue'],
      markers: ['-r', '--resume']
    })
}
