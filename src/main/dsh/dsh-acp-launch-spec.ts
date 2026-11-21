import { join } from 'node:path'
import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import { GENERIC_ACP_DIALECT } from '../acp/acp-dialects/acp-dialect'
import { directoryAccountBinding } from '../acp/launch/acp-account-binding'
import { deliverDshInstructions, undoDshInstructions } from '../acp/launch/acp-instructions'
import { agentSessionSetupFor } from '../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import type { StructuredAgentSessionHistory } from '../native-chat/conversation-adoption/structured-agent-cli-conversations'

// Chats and terminals share DSH_HOME's session store; a chat reopens through ACP's session/resume,
// so DSH's launcher never carries a resume flag on a chat's command line.
const DSH_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: [],
  rowSessionId: (link) => link.handle.nativeId,
  parseResumeArgs: () => null
}

export const DSH_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'dsh',
  command: 'dsh',
  // The shipped `acp` profile is the JSON-RPC stdio server; `dsh-tui` remains the terminal profile.
  args: () => ['--profile', 'acp'],
  env: {},
  // Its `acp` profile already speaks standard ACP v1.
  dialect: GENERIC_ACP_DIALECT,
  loginCommand: agentSessionSetupFor('dsh')?.loginCommand ?? [],
  account: directoryAccountBinding('DSH_HOME', (homePath) => join(homePath, '.dsh')),
  // npm, Homebrew and the desktop app all put `dsh` on PATH.
  installDirectories: () => [],
  // DSH cannot delete sessions, so a listing session would stay in DSH_HOME's store.
  modelDiscovery: {
    kind: 'unavailable',
    reason: 'DeepSeek Harness lists its models only inside a session it cannot delete'
  },
  instructions: deliverDshInstructions,
  undoInstructions: undoDshInstructions,
  instructionsInWorkspace: true,
  transcriptImport: null,
  sessionHistory: DSH_SESSION_HISTORY,
  // No session/delete: a naming task's session would land in the user's own DSH history.
  keepsEverySession: true
}
