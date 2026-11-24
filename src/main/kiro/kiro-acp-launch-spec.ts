import { join } from 'node:path'
import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import { directoryAccountBinding } from '../acp/launch/acp-account-binding'
import { KIRO_ACP_DIALECT } from '../acp/acp-dialects/kiro-dialect'
import { KIRO_MODEL_LISTING_ARGS, parseKiroModelListing } from './kiro-model-listing'
import { deliverKiroInstructions } from '../acp/launch/acp-instructions'
import { agentSessionSetupFor } from '../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import {
  resumeInvocationFromOptions,
  type StructuredAgentSessionHistory
} from '../native-chat/conversation-adoption/structured-agent-cli-conversations'

// Chats and terminals share Kiro's session store and `sess_<uuid>` ids.
const KIRO_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: ['kiro'],
  rowSessionId: (link) => link.handle.nativeId,
  parseResumeArgs: (args) =>
    resumeInvocationFromOptions(args, {
      targetless: ['-r', '--resume', '--resume-picker'],
      markers: ['--resume-id']
    })
}

export const KIRO_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'kiro',
  command: 'kiro-cli',
  // The terminal agent's Command setting runs `kiro-cli chat --tui`, which serves no ACP.
  ignoreAgentCommandSetting: true,
  // The v2 engine speaks another protocol, and v3 rejects the v2 trust flags, so Full access
  // approves each permission request. `--auth-method cli` keeps tokens in `kiro-cli login`'s store.
  args: () => ['acp', '--agent-engine', 'v3', '--auth-method', 'cli'],
  env: {},
  dialect: KIRO_ACP_DIALECT,
  loginCommand: agentSessionSetupFor('kiro')?.loginCommand ?? [],
  // V3 reads settings, sessions and hooks from KIRO_HOME.
  account: directoryAccountBinding('KIRO_HOME', (homePath) => join(homePath, '.kiro')),
  installDirectories: ({ env, homePath }) => [
    join(homePath, '.local', 'bin'),
    ...(env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, 'Kiro-Cli')] : [])
  ],
  // The oldest release checked live; V3 before 2.31 ignores KIRO_HOME and keeps sessions in ~/.kiro.
  minimumVersions: ['3.1.0'],
  // Lists the account's models without starting the V3 engine.
  modelDiscovery: {
    kind: 'command',
    args: KIRO_MODEL_LISTING_ARGS,
    parse: parseKiroModelListing,
    listingNamesConfiguredModel: false
  },
  instructions: deliverKiroInstructions,
  transcriptImport: null,
  sessionHistory: KIRO_SESSION_HISTORY
}
