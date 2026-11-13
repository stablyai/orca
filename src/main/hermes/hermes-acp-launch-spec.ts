import { join } from 'node:path'
import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import { GENERIC_ACP_DIALECT } from '../acp/acp-dialects/acp-dialect'
import { directoryAccountBinding } from '../acp/launch/acp-account-binding'
import { agentSessionSetupFor } from '../../shared/agent-session/lifecycle/agent-session-setup-commands'
import {
  resumeInvocationFromOptions,
  type StructuredAgentSessionHistory
} from '../native-chat/conversation-adoption/structured-agent-cli-conversations'

// Chats and terminals share Hermes' session store under ~/.hermes.
const HERMES_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: ['hermes'],
  rowSessionId: (link) => link.handle.nativeId,
  parseResumeArgs: (args) =>
    resumeInvocationFromOptions(args, {
      targetless: ['--continue'],
      markers: ['-r', '--resume']
    })
}

export const HERMES_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'hermes',
  command: 'hermes',
  args: () => ['acp'],
  env: {},
  dialect: GENERIC_ACP_DIALECT,
  loginCommand: agentSessionSetupFor('hermes')?.loginCommand ?? [],
  account: directoryAccountBinding('HERMES_HOME', (homePath) => join(homePath, '.hermes')),
  installDirectories: () => [],
  // Only a session lists the models its account allows.
  modelDiscovery: { kind: 'session', listingNamesConfiguredModel: false },
  transcriptImport: null,
  sessionHistory: HERMES_SESSION_HISTORY
}
