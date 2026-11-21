import { join } from 'node:path'
import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import { OPENCODE_ACP_DIALECT } from '../acp/acp-dialects/opencode-dialect'
import { directoryAccountBinding } from '../acp/launch/acp-account-binding'
import { deliverKiloInstructions } from '../acp/launch/acp-instructions'
import {
  OPENCODE_MODEL_LISTING_ARGS,
  parseOpenCodeModelListing
} from '../opencode/model-launch/opencode-model-catalog-listing'
import { agentSessionSetupFor } from '../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'

// An OpenCode 1.x fork under KILO_* names; sign-in and sessions live in `<XDG_DATA_HOME>/kilo`.
export const KILO_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'kilo',
  command: 'kilo',
  // No bypass flag; full access approves permission requests individually.
  args: () => ['acp'],
  // Its ACP cannot answer the question tool.
  env: { KILO_ENABLE_QUESTION_TOOL: 'false' },
  // Kilo's Build mode is `code`.
  dialect: { ...OPENCODE_ACP_DIALECT, interactionModes: { default: 'code', plan: 'plan' } },
  historyCatchUp: 'user-message-id',
  loginCommand: agentSessionSetupFor('kilo')?.loginCommand ?? [],
  account: directoryAccountBinding('XDG_DATA_HOME', (homePath) =>
    join(homePath, '.local', 'share')
  ),
  // The install script's default location.
  installDirectories: ({ homePath }) => [join(homePath, '.kilo', 'bin')],
  modelDiscovery: {
    kind: 'command',
    args: OPENCODE_MODEL_LISTING_ARGS,
    parse: parseOpenCodeModelListing,
    listingNamesConfiguredModel: false
  },
  // Read again at every start, so a reopened conversation takes the current ones.
  instructions: deliverKiloInstructions,
  compaction: true,
  transcriptImport: null,
  // Session History does not read Kilo's store, so no row links a chat to its terminal sessions.
  sessionHistory: {
    rowAgents: [],
    rowSessionId: (link) => link.handle.nativeId,
    parseResumeArgs: () => null
  }
}
