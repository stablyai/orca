import { join } from 'node:path'
import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import { QWEN_CODE_ACP_DIALECT } from '../acp/acp-dialects/qwen-code-dialect'
import { directoryAccountBinding } from '../acp/launch/acp-account-binding'
import { windowsLocalAppDataBinDirectories } from '../acp/launch/acp-windows-install-directories'
import { deliverQwenCodeInstructions } from '../acp/launch/acp-instructions'
import { agentSessionSetupFor } from '../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import {
  resumeInvocationFromOptions,
  type StructuredAgentSessionHistory
} from '../native-chat/conversation-adoption/structured-agent-cli-conversations'

// Chats and terminals share QWEN_HOME's session store; Session History does not list Qwen rows yet.
const QWEN_CODE_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: [],
  rowSessionId: (link) => link.handle.nativeId,
  parseResumeArgs: (args) =>
    resumeInvocationFromOptions(args, {
      targetless: ['-c', '--continue'],
      markers: ['-r', '--resume']
    })
}

export const QWEN_CODE_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'qwen-code',
  command: 'qwen',
  args: () => ['--acp'],
  env: {},
  dialect: QWEN_CODE_ACP_DIALECT,
  loginCommand: agentSessionSetupFor('qwen-code')?.loginCommand ?? [],
  account: directoryAccountBinding('QWEN_HOME', (homePath) => join(homePath, '.qwen')),
  installDirectories: ({ env, homePath }) =>
    process.platform === 'win32'
      ? windowsLocalAppDataBinDirectories(env, homePath, 'qwen-code')
      : [join(homePath, '.local', 'bin')],
  // 0.16.0 added the auto mode that Approve for me selects.
  minimumVersions: ['0.16.0'],
  // Qwen enforces its own modes, and a new session may start in its auto mode, so each start sets one.
  permissionModeConfig: {
    values: { ask: 'default', 'accept-edits': 'auto-edit', auto: 'auto', 'full-access': 'yolo' }
  },
  // Only a session lists models, and Qwen cannot delete a listing session.
  modelDiscovery: {
    kind: 'unavailable',
    reason: 'Qwen Code lists its models only inside a session it cannot delete'
  },
  instructions: deliverQwenCodeInstructions,
  instructionsInWorkspace: true,
  compaction: true,
  compactionInstructions: true,
  transcriptImport: null,
  sessionHistory: QWEN_CODE_SESSION_HISTORY,
  // No session/delete: a naming task's session would land in the user's Qwen history.
  keepsEverySession: true
}
