import { join } from 'node:path'
import type { AcpLaunchSpec } from '../acp/acp-launch-specs'
import { directoryAccountBinding } from '../acp/acp-account-binding'
import { KIRO_ACP_DIALECT } from '../acp/acp-dialects/kiro-dialect'
import type { StructuredAgentSessionHistory } from '../native-chat/structured-agent-cli-conversations'
import { agentSessionSignInFor } from '../../shared/agent-session/lifecycle/agent-session-sign-in'

// Chats cannot adopt Kiro's terminal conversations yet.
const KIRO_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: ['kiro'],
  rowSessionId: (link) => link.handle.nativeId,
  parseResumeArgs: () => null
}

export const KIRO_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'kiro',
  command: 'kiro-cli',
  // The terminal agent's Command setting runs `kiro-cli chat --tui`, which serves no ACP.
  ignoreAgentCommandSetting: true,
  // The default v2 engine speaks another protocol, and v3 rejects the v2 trust flags, so Full access
  // approves each permission request. `--auth-method cli` keeps tokens in `kiro-cli login`'s store.
  args: () => ['acp', '--agent-engine', 'v3', '--auth-method', 'cli'],
  env: {},
  dialect: KIRO_ACP_DIALECT,
  loginCommand: agentSessionSignInFor('kiro')?.loginCommand ?? [],
  // V3 ignores KIRO_HOME and reads its sign-in from the CLI store; the default home matches V2.
  account: directoryAccountBinding('KIRO_HOME', (homePath) => join(homePath, '.kiro')),
  installDirectories: ({ env, homePath }) => [
    join(homePath, '.local', 'bin'),
    ...(env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, 'Kiro-Cli')] : [])
  ],
  // First release verified to serve the V3 engine over ACP.
  minimumVersions: ['2.29.1'],
  // Kiro reports its `model` option only after `session/new` returns, so live chats list models.
  modelDiscovery: {
    kind: 'unavailable',
    reason: 'Kiro lists its models only after a chat session starts'
  },
  transcriptImport: null,
  sessionHistory: KIRO_SESSION_HISTORY
}
