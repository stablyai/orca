import { homedir } from 'node:os'
import { join } from 'node:path'
import { agentSessionAccountHome } from '../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import { supportsSupervisedProviderChildLocation } from '../provider-process/supervised-provider-child-location'
import type { StructuredAgentRuntimeMetadata } from '../runtime/agent-session/installation/structured-agent-runtime-registration-types'
import { OMP_RPC_AGENT } from './rpc-agent-definition'
import { resolvePiRpcCommand } from '../pi/rpc/launch/rpc-launch-resolution'
import { PI_RPC_FAMILY_OMP } from '../pi/rpc/pi-rpc-family'
import { createPiModelCatalogProbe } from '../pi/rpc/options/rpc-model-catalog-probe'
import { managedAgentCli } from '../managed-agent-cli/managed-agent-cli-registry'
import { OMP_SESSION_HISTORY } from './omp-session-history'
import { OMP_TRANSCRIPT_IMPORT } from './omp-transcript-import'

export const OMP_RPC_RUNTIME_METADATA: StructuredAgentRuntimeMetadata = {
  definition: OMP_RPC_AGENT,
  modelCatalog: (context) => ({
    kind: 'probe',
    // `get_available_models` marks no model as the one OMP runs by default.
    listingNamesConfiguredModel: false,
    probe: createPiModelCatalogProbe({
      family: PI_RPC_FAMILY_OMP,
      resolveEnvironment: () => context.environment.resolveAgentEnvironment('omp'),
      resolveSavedEnvironment: () => context.environment.resolveAgentEnvironment('omp', true),
      refreshEnvironmentAfterMiss: context.environment.refreshAfterMissingProgram,
      ...(context.deps.resolveAgentCommandSettings
        ? { resolveCommandSettings: context.deps.resolveAgentCommandSettings }
        : {})
    })
  }),
  transcriptImport: OMP_TRANSCRIPT_IMPORT,
  sessionHistory: OMP_SESSION_HISTORY,
  supportsLocation: supportsSupervisedProviderChildLocation,
  launchCheck: {
    resolveLaunch: (env, commandSettings) => ({
      ...resolvePiRpcCommand(env, commandSettings, undefined, 'omp'),
      env
    }),
    minimumVersions: PI_RPC_FAMILY_OMP.minimumVersions
  },
  chatProgram: {
    resolve: (env, commandSettings) => ({
      ...resolvePiRpcCommand(env, commandSettings, undefined, 'omp'),
      env
    }),
    // Hosts without the user's own install can install Orca's copy.
    installable: () => managedAgentCli('omp').available()
  },
  resolveAccountHome: async ({ launchEnv }) =>
    agentSessionAccountHome(
      OMP_RPC_AGENT,
      launchEnv.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.omp', 'agent')
    )
}
