import { homedir } from 'node:os'
import { join } from 'node:path'
import { agentSessionAccountHome } from '../../shared/agent-session-account-home'
import { supportsSupervisedProviderChildLocation } from '../provider-process/supervised-provider-child-location'
import type { StructuredAgentRuntimeMetadata } from '../runtime/structured-agent-runtime-registration-types'
import { PI_RPC_AGENT } from './rpc-agent-definition'
import { piRpcVersionSupported, resolvePiRpcCommand } from './rpc-launch-resolution'
import { createPiModelCatalogProbe } from './rpc-model-catalog-probe'
import { PI_SESSION_HISTORY } from './pi-session-history'
import { PI_TRANSCRIPT_IMPORT } from './pi-transcript-import'

export const PI_RPC_RUNTIME_METADATA: StructuredAgentRuntimeMetadata = {
  definition: PI_RPC_AGENT,
  modelCatalog: (context) => ({
    kind: 'probe',
    // `--list-models` marks no model as the one Pi runs by default.
    listingNamesConfiguredModel: false,
    probe: createPiModelCatalogProbe({
      // The environment a chat's launch starts from too.
      resolveEnvironment: () => context.environment.resolveAgentEnvironment('pi'),
      refreshEnvironmentAfterMiss: context.environment.refreshAfterMissingProgram,
      ...(context.deps.resolveAgentCommandSettings
        ? { resolveCommandSettings: context.deps.resolveAgentCommandSettings }
        : {})
    })
  }),
  transcriptImport: PI_TRANSCRIPT_IMPORT,
  sessionHistory: PI_SESSION_HISTORY,
  supportsLocation: supportsSupervisedProviderChildLocation,
  launchCheck: {
    resolveLaunch: (env, commandSettings) => ({
      command: resolvePiRpcCommand(env, commandSettings),
      env
    }),
    supportsVersion: (launch) => piRpcVersionSupported(launch)
  },
  resolveAccountHome: async ({ launchEnv }) =>
    agentSessionAccountHome(
      PI_RPC_AGENT,
      launchEnv.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent')
    )
}
