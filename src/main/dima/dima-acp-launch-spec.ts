import { join } from 'node:path'
import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import { DIMA_ACP_DIALECT } from '../acp/acp-dialects/dima-dialect'
import { directoryAccountBinding } from '../acp/launch/acp-account-binding'
import { agentSessionSetupFor } from '../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import type { StructuredAgentSessionHistory } from '../native-chat/conversation-adoption/structured-agent-cli-conversations'
import type { PublishSharedToolProcessSessionEnv } from '../runtime/agent-session/environment/shared-tool-process-session-env'

// Orca lists no dima sessions in Session History, and its terminals reopen them from dima's picker.
const DIMA_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: [],
  rowSessionId: (link) => link.handle.nativeId,
  parseResumeArgs: () => null
}

// Every session's tools run in dima's one daemon, and 0.1.0-alpha.25 has no per-session environment,
// so they keep no chat's identity rather than the one the daemon started with.
const publishDimaSessionToolEnv: PublishSharedToolProcessSessionEnv = async ({ mustReach }) => {
  if (mustReach) {
    throw new Error("dima's shared daemon cannot give one session's tools their own identity")
  }
  return async () => undefined
}

export const DIMA_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'dima',
  command: 'dima',
  // No --provider/--model: the chat picks from its session's own model option.
  args: () => ['acp'],
  env: {},
  dialect: DIMA_ACP_DIALECT,
  loginCommand: agentSessionSetupFor('dima')?.loginCommand ?? [],
  // dimcode-alpha keeps sign-in, providers, settings and sessions under ~/.dimcode-alpha.
  account: directoryAccountBinding('DIMCODE_HOME', (homePath) => join(homePath, '.dimcode-alpha')),
  installDirectories: () => [],
  // The oldest release checked to serve ACP chats.
  minimumVersions: ['0.1.0-alpha.25'],
  // dima enforces its session presets: read-only refuses edits and commands instead of asking, and
  // workspace-write allows workspace edits but asks before commands.
  permissionModeConfig: {
    values: { ask: 'read-only', 'accept-edits': 'workspace-write', 'full-access': 'full-access' }
  },
  // A listing session is deleted afterwards. Its ids are native, and dima omits ids two providers share.
  modelDiscovery: { kind: 'session', listingNamesConfiguredModel: false, listsOnDemand: true },
  compaction: true,
  transcriptImport: null,
  sessionHistory: DIMA_SESSION_HISTORY,
  sharedToolProcess: { publishSessionEnv: publishDimaSessionToolEnv }
}
