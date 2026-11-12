import { join } from 'node:path'
import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import { KIMI_ACP_DIALECT } from '../acp/acp-dialects/kimi-dialect'
import { directoryAccountBinding } from '../acp/launch/acp-account-binding'
import { agentSessionSetupFor } from '../../shared/agent-session/lifecycle/agent-session-setup-commands'
import {
  resumeInvocationFromOptions,
  type StructuredAgentSessionHistory
} from '../native-chat/structured-agent-cli-conversations'

// Chats and terminals share Kimi's session store and `session_<uuid>` ids.
const KIMI_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: ['kimi'],
  rowSessionId: (link) => link.handle.nativeId,
  parseResumeArgs: (args) =>
    resumeInvocationFromOptions(args, {
      targetless: ['-c', '--continue'],
      markers: ['-S', '--session', '-r', '--resume']
    })
}

export const KIMI_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'kimi',
  command: 'kimi',
  args: () => ['acp'],
  // A staged update would otherwise replace the binary when the chat starts.
  env: { KIMI_CODE_NO_AUTO_UPDATE: '1' },
  dialect: KIMI_ACP_DIALECT,
  loginCommand: agentSessionSetupFor('kimi')?.loginCommand ?? [],
  account: directoryAccountBinding('KIMI_CODE_HOME', (homePath) => join(homePath, '.kimi-code')),
  // The install scripts' default location.
  installDirectories: ({ homePath }) => [join(homePath, '.kimi-code', 'bin')],
  // 2.5.0 stopped failing initialize when the client's first request arrives during startup.
  minimumVersions: ['2.5.0'],
  // Kimi enforces its modes, and config.toml's default_permission_mode applies until one is set.
  // Its ACP descriptions swap these: `yolo` still asks before risky commands, `auto` never asks.
  permissionModeConfig: {
    values: { ask: 'default', auto: 'yolo', 'full-access': 'auto' }
  },
  // Session discovery deletes its listing session.
  modelDiscovery: { kind: 'session', listingNamesConfiguredModel: false },
  compaction: true,
  compactionInstructions: true,
  transcriptImport: null,
  sessionHistory: KIMI_SESSION_HISTORY
}
