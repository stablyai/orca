import { join } from 'node:path'
import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import { OPENCODE_ACP_DIALECT } from '../acp/acp-dialects/opencode-dialect'
import { directoryAccountBinding } from '../acp/launch/acp-account-binding'
import { deliverMimoInstructions } from '../acp/launch/acp-instructions'
import {
  OPENCODE_MODEL_LISTING_ARGS,
  parseOpenCodeModelListing
} from '../opencode/model-launch/opencode-model-catalog-listing'
import type { AgentSessionModelOption } from '../../shared/agent-session/options/model-catalog/agent-session-model-option'
import { agentSessionSetupFor } from '../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'

// Its ACP takes a variant as a model of its own (`<provider>/<model>/<variant>`), never as an effort.
function parseMimoModelListing(stdout: string): AgentSessionModelOption[] {
  return parseOpenCodeModelListing(stdout).map((model) => ({
    ...model,
    efforts: [],
    defaultEffort: undefined,
    declaredDefaultEffort: null
  }))
}

// An OpenCode 1.x fork under MIMOCODE_* names; sign-in and sessions live in `<XDG_DATA_HOME>/mimocode`.
export const MIMO_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'mimo-code',
  command: 'mimo',
  // No bypass flag; full access approves permission requests individually.
  args: () => ['acp'],
  // Its ACP cannot answer the question tool.
  env: { MIMOCODE_ENABLE_QUESTION_TOOL: 'false' },
  dialect: OPENCODE_ACP_DIALECT,
  historyCatchUp: 'user-message-id',
  loginCommand: agentSessionSetupFor('mimo-code')?.loginCommand ?? [],
  account: directoryAccountBinding('XDG_DATA_HOME', (homePath) =>
    join(homePath, '.local', 'share')
  ),
  // The install script's default location.
  installDirectories: ({ homePath }) => [join(homePath, '.mimocode', 'bin')],
  modelDiscovery: {
    kind: 'command',
    args: OPENCODE_MODEL_LISTING_ARGS,
    parse: parseMimoModelListing,
    listingNamesConfiguredModel: false
  },
  // Kept with the session: a reopened conversation keeps the instructions it began with.
  instructions: deliverMimoInstructions,
  compaction: true,
  transcriptImport: null,
  // Session History does not read MiMo's store, so no row links a chat to its terminal sessions.
  sessionHistory: {
    rowAgents: [],
    rowSessionId: (link) => link.handle.nativeId,
    parseResumeArgs: () => null
  }
}
