import { homedir } from 'node:os'
import { join } from 'node:path'
import { agentSessionAccountHome } from '../../shared/agent-session-account-home'
import type { StructuredAgentRuntimeMetadata } from '../runtime/structured-agent-runtime-registration-types'
import { supportsSupervisedProviderChildLocation } from '../provider-process/supervised-provider-child-location'
import { OMP_RPC_AGENT } from './rpc-agent-definition'
import { OMP_RPC_MINIMUM_VERSIONS, resolveOmpRpcCommand } from './rpc-launch'
import { createOmpRpcModelCatalogProbe } from './rpc-model-catalog-probe'
import { OMP_TRANSCRIPT_IMPORT } from './omp-transcript-import'
import { OMP_SESSION_HISTORY } from './omp-session-history'

export const OMP_RPC_RUNTIME_METADATA: StructuredAgentRuntimeMetadata = {
  definition: OMP_RPC_AGENT,
  modelCatalog: (context) => ({
    kind: 'probe',
    listingNamesConfiguredModel: true,
    listsInChatFolder: true,
    probe: createOmpRpcModelCatalogProbe(context)
  }),
  transcriptImport: { ...OMP_TRANSCRIPT_IMPORT, handleNamesTranscript: true },
  sessionHistory: OMP_SESSION_HISTORY,
  supportsLocation: supportsSupervisedProviderChildLocation,
  launchCheck: {
    minimumVersions: OMP_RPC_MINIMUM_VERSIONS,
    resolveLaunch: (env, settings) => ({ ...resolveOmpRpcCommand(env, settings), env })
  },
  chatProgram: {
    resolve: (env, settings) => ({ ...resolveOmpRpcCommand(env, settings), env })
  },
  resolveAccountHome: async ({ launchEnv }) =>
    agentSessionAccountHome(
      OMP_RPC_AGENT,
      launchEnv.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.omp', 'agent')
    )
}
