import { join } from 'node:path'
import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import { directoryAccountBinding } from '../acp/launch/acp-account-binding'
import { TRAE_ACP_DIALECT } from '../acp/acp-dialects/trae-dialect'
import { resolveTraeCliHome } from './trae-cli-home'
import { parseTraeModelListing } from './trae-model-catalog'
import { agentSessionSetupFor } from '../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import {
  directoryTranscriptImport,
  resumeInvocationFromOptions,
  type StructuredAgentSessionHistory
} from '../native-chat/conversation-adoption/structured-agent-cli-conversations'
import { findSessionFileInDirs } from '../native-chat/session-file-resolver'

const TRAE_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: ['trae'],
  rowSessionId: (link) => link.handle.nativeId,
  parseResumeArgs: (args) =>
    resumeInvocationFromOptions(args, {
      targetless: ['--last'],
      markers: ['resume', '--resume', '--session-id']
    })
}

export const TRAE_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'trae',
  command: 'traecli',
  args: () => ['acp', 'serve'],
  env: {},
  dialect: TRAE_ACP_DIALECT,
  historyCatchUp: 'user-message-id',
  loginCommand: agentSessionSetupFor('trae')?.loginCommand ?? [],
  account: directoryAccountBinding('TRAECLI_HOME', (homePath, env) =>
    resolveTraeCliHome(env, homePath)
  ),
  installDirectories: ({ homePath }) => [join(homePath, '.local', 'bin')],
  minimumVersions: ['0.216.0'],
  permissionModeConfig: {
    values: { ask: 'default', auto: 'auto', 'full-access': 'bypass_permissions' }
  },
  modelDiscovery: {
    kind: 'command',
    args: ['models', '--json'],
    parse: parseTraeModelListing,
    listingNamesConfiguredModel: false
  },
  instructions: async ({ text }) => ({
    sessionParameters: {
      systemPrompt: { mode: 'append', content: [{ type: 'text', text }] }
    },
    sessionParametersOnReopen: true
  }),
  compaction: true,
  compactionInstructions: true,
  transcriptImport: directoryTranscriptImport({
    conversationStore: ({ accountHomePath }) => join(accountHomePath, 'sessions'),
    accountHomeCandidates: ({ selectedAccountHomePath }) => [selectedAccountHomePath],
    findTranscript: ({ providerSessionId, store, strictErrors }) =>
      findSessionFileInDirs('codex', providerSessionId, [store], {
        strictErrors
      })
  }),
  sessionHistory: TRAE_SESSION_HISTORY,
  keepsEverySession: true
}
