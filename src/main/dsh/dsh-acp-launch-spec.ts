import { join } from 'node:path'
import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import { DSH_ACP_DIALECT } from '../acp/acp-dialects/dsh-dialect'
import { directoryAccountBinding } from '../acp/launch/acp-account-binding'
import { deliverDshInstructions, undoDshInstructions } from '../acp/launch/acp-instructions'
import { agentSessionSetupFor } from '../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import type { StructuredAgentSessionHistory } from '../native-chat/conversation-adoption/structured-agent-cli-conversations'
import { discardDshListingSession } from './dsh-listing-session-discard'

// AI Vault does not scan DSH session logs yet, so Session History lists no DSH rows.
const DSH_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: [],
  rowSessionId: (link) => link.handle.nativeId,
  parseResumeArgs: () => null
}

export const DSH_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'dsh',
  command: 'dsh',
  // The terminal agent's Command setting points at `dsh-tui`, whereas chat runs `dsh --profile acp`.
  ignoreAgentCommandSetting: true,
  args: () => ['--profile', 'acp'],
  env: {},
  dialect: DSH_ACP_DIALECT,
  loginCommand: agentSessionSetupFor('dsh')?.loginCommand ?? [],
  account: directoryAccountBinding('DSH_HOME', (homePath) => join(homePath, '.dsh')),
  installDirectories: () => [],
  // Models follow DSH_HOME, not the workspace; discard the temporary listing session after exit.
  modelDiscovery: {
    kind: 'session',
    listingNamesConfiguredModel: false,
    inPrivateFolder: true,
    listsOnDemand: true,
    discardSession: discardDshListingSession
  },
  instructions: deliverDshInstructions,
  undoInstructions: undoDshInstructions,
  instructionsInWorkspace: true,
  transcriptImport: null,
  sessionHistory: DSH_SESSION_HISTORY,
  // No session/delete: a naming task's session would land in the user's DSH history.
  keepsEverySession: true
}
