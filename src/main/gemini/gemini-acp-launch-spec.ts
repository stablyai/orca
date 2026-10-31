import { directoryAccountBinding } from '../acp/acp-account-binding'
import type { AcpLaunchSpec } from '../acp/acp-launch-specs'
import { GEMINI_ACP_DIALECT, readGeminiAcpSignInLine } from './gemini-acp-dialect'
import { agentSessionSignInFor } from '../../shared/agent-session-sign-in'
import { resumeInvocationFromOptions } from '../native-chat/structured-agent-cli-conversations'

export const GEMINI_ACP_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'gemini',
  command: 'gemini',
  // Orca answers Full access approvals individually; saved CLI defaults must not bypass Ask.
  args: () => ['--acp', '--approval-mode', 'default'],
  env: { NO_BROWSER: 'true' },
  dialect: GEMINI_ACP_DIALECT,
  loginCommand: agentSessionSignInFor('gemini')?.loginCommand ?? [],
  signIn: { read: readGeminiAcpSignInLine },
  // GEMINI_CLI_HOME is a home root: the CLI appends .gemini itself.
  account: directoryAccountBinding('GEMINI_CLI_HOME', (homePath) => homePath),
  installDirectories: () => [],
  // First verified original CLI release with the stable --acp spelling and this protocol.
  minimumVersions: ['0.65.0'],
  // session/load returns before unmarked history finishes, which can overlap the next prompt.
  resumeUnavailable: true,
  restingOptionKeys: ['model'],
  // Models arrive with session/new or load; no ACP deletion or disposable history directory.
  modelDiscovery: {
    kind: 'unavailable',
    reason: 'Gemini CLI lists its models only in a signed-in session'
  },
  transcriptImport: null,
  sessionHistory: {
    rowAgents: ['gemini'],
    rowSessionId: (link) => link.handle.nativeId,
    parseResumeArgs: (args) => {
      const invocation = resumeInvocationFromOptions(args, {
        targetless: [],
        markers: ['-r', '--resume']
      })
      return invocation?.target === 'latest' || /^\d+$/.test(invocation?.target ?? '')
        ? { target: null }
        : invocation
    }
  }
}
