import { join } from 'node:path'
import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import { COPILOT_ACP_DIALECT } from '../acp/acp-dialects/copilot-dialect'
import { directoryAccountBinding } from '../acp/launch/acp-account-binding'
import { agentSessionSetupFor } from '../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import {
  resumeInvocationFromOptions,
  sessionFileResumeTargetMatches,
  type StructuredAgentSessionHistory
} from '../native-chat/conversation-adoption/structured-agent-cli-conversations'

// Chats and terminals share Copilot's session store; `--resume` also takes ID prefixes.
const COPILOT_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: ['copilot'],
  rowSessionId: (link) => link.handle.nativeId,
  parseResumeArgs: (args) =>
    resumeInvocationFromOptions(args, {
      targetless: ['--continue'],
      markers: ['-r', '--resume', '--session-id']
    }),
  resumeTargetMatches: sessionFileResumeTargetMatches
}

// Copilot uses its own sign-in (or gh's), so GH_HOST and enterprise policy carry over unchanged.
export const COPILOT_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'copilot',
  command: 'copilot',
  // No bypass flag; full access approves permission requests individually.
  args: () => ['--acp'],
  env: {},
  // An inherited allow-all would approve everything while the chat shows Ask.
  scrubEnvironment: (env) => {
    delete env.COPILOT_ALLOW_ALL
    return ['COPILOT_ALLOW_ALL']
  },
  dialect: COPILOT_ACP_DIALECT,
  loginCommand: agentSessionSetupFor('copilot')?.loginCommand ?? [],
  account: directoryAccountBinding('COPILOT_HOME', (homePath) => join(homePath, '.copilot')),
  // The install script's default prefix for a non-root user.
  installDirectories: ({ homePath }) => [join(homePath, '.local', 'bin')],
  // Earlier ACP sessions ran without the enterprise's managed settings (policy, MCP, permissions).
  minimumVersions: ['1.0.88'],
  // Only a session lists the models a plan allows, and Copilot cannot delete a listing session.
  modelDiscovery: {
    kind: 'unavailable',
    reason: 'Copilot lists the models a plan allows only inside a session'
  },
  compaction: true,
  compactionInstructions: true,
  transcriptImport: null,
  sessionHistory: COPILOT_SESSION_HISTORY,
  // No session/delete: a naming task's session would land in the user's Copilot history.
  keepsEverySession: true
}
