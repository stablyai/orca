import { join } from 'node:path'
import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import { CLINE_ACP_DIALECT } from '../acp/acp-dialects/cline-dialect'
import { directoryAccountBinding } from '../acp/launch/acp-account-binding'
import { deliverClineInstructions } from '../acp/launch/acp-instructions'
import { agentSessionSetupFor } from '../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import {
  resumeInvocationFromOptions,
  type StructuredAgentSessionHistory
} from '../native-chat/conversation-adoption/structured-agent-cli-conversations'

// Chats and terminals share Cline's session store; `cline --id <id>` resumes one.
const CLINE_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: ['cline'],
  rowSessionId: (link) => link.handle.nativeId,
  parseResumeArgs: (args) =>
    resumeInvocationFromOptions(args, { targetless: [], markers: ['--id'] })
}

export const CLINE_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'cline',
  command: 'cline',
  // Nothing is auto-approved, so Orca answers every permission request.
  args: () => ['--acp'],
  // Otherwise sessions move into Cline's background hub, whose tools keep the environment of the
  // process that started it rather than the chat's own (checked on 3.0.75).
  env: { CLINE_SESSION_BACKEND_MODE: 'local' },
  dialect: CLINE_ACP_DIALECT,
  loginCommand: agentSessionSetupFor('cline')?.loginCommand ?? [],
  // The whole config root: sign-in, settings, MCP servers and sessions.
  account: directoryAccountBinding('CLINE_DIR', (homePath) => join(homePath, '.cline')),
  installDirectories: () => [],
  // The oldest release checked to serve ACP chats.
  minimumVersions: ['3.0.66'],
  // Only a session lists the provider's models, and Cline cannot delete a listing session.
  modelDiscovery: {
    kind: 'unavailable',
    reason: 'Cline lists its models only inside a session it cannot delete'
  },
  // Its ACP server ignores `session/new` mcpServers (3.0.75).
  botToolsOff: "Cline doesn't load the tools Orca passes to its chats",
  instructions: deliverClineInstructions,
  instructionsInWorkspace: true,
  transcriptImport: null,
  sessionHistory: CLINE_SESSION_HISTORY,
  // No session/delete: a naming task's session would land in the user's Cline history.
  keepsEverySession: true
}
