import { homedir } from 'node:os'
import { join } from 'node:path'
import { agentSessionAccountHome } from '../../../shared/agent-session/lifecycle/agent-session-account-home'
import { supportsSupervisedProviderChildLocation } from '../../provider-process/supervised-provider-child-location'
import { zcodeModelCatalogDiscovery } from '../../runtime/agent-session/model-catalog/structured-agent-model-catalog-discovery'
import type { StructuredAgentRuntimeMetadata } from '../../runtime/agent-session/installation/structured-agent-runtime-registration-types'
import { ZCODE_STRUCTURED_AGENT } from './launch/zcode-structured-agent-definition'
import { resolveStructuredAgentCommand } from '../../native-chat/structured-agent-command-resolution'
import type { StructuredAgentSessionHistory } from '../../native-chat/structured-agent-cli-conversations'

export const ZCODE_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: ['zcode'],
  rowSessionId: (link) => link.handle.nativeId,
  // zcode chats resume through their provider handles; CLI argv adoption is not wired yet.
  parseResumeArgs: () => null
}

export const ZCODE_RUNTIME_METADATA: StructuredAgentRuntimeMetadata = {
  definition: ZCODE_STRUCTURED_AGENT,
  // zcode conversations live in its own SQLite store, which the opencode-family transcript
  // reader already parses; wiring adoption is follow-up work, so import nothing yet.
  transcriptImport: null,
  sessionHistory: ZCODE_SESSION_HISTORY,
  // A disposable backend session lists the pushed account's models; sessions report live changes.
  modelCatalog: zcodeModelCatalogDiscovery,
  supportsLocation: supportsSupervisedProviderChildLocation,
  chatProgram: {
    resolve: (env, commandSettings) => {
      const homePath = env.HOME ?? env.USERPROFILE
      const pathEnv = env.PATH ?? env.Path ?? null
      const options = { pathEnv, ...(homePath ? { homePath } : {}) }
      const resolved = resolveStructuredAgentCommand('zcode', commandSettings, options)
      return {
        command: resolved.command,
        prefixArgs: resolved.prefixArgs,
        env: { ...env }
      }
    }
  },
  resolveAccountHome: async ({ launchEnv }) =>
    agentSessionAccountHome(
      ZCODE_STRUCTURED_AGENT,
      launchEnv.ZCODE_HOME?.trim() || join(homedir(), '.zcode')
    )
}
