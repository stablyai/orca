import { agentSessionAccountHome } from '../../shared/agent-session/lifecycle/agent-session-account-home'
import { TRAEX_CLI_CONVERSATIONS } from './traex-cli-conversations'
import { supportsSupervisedProviderChildLocation } from '../provider-process/supervised-provider-child-location'
import type { StructuredAgentRuntimeMetadata } from '../runtime/agent-session/installation/structured-agent-runtime-registration-types'
import { TRAEX_STRUCTURED_AGENT } from './traex-agent-definition'
import {
  resolveTraexCommand,
  traexPrivateHome,
  TRAEX_MINIMUM_VERSIONS
} from './traex-launch-resolution'
import { createTraexModelCatalogProbe } from './traex-model-catalog-probe'

const chatProgram = {
  resolve: (env: Record<string, string>, settings: Parameters<typeof resolveTraexCommand>[1]) => ({
    ...resolveTraexCommand(env, settings),
    env
  })
}

export const TRAEX_RUNTIME_METADATA: StructuredAgentRuntimeMetadata = {
  definition: TRAEX_STRUCTURED_AGENT,
  supportsLocation: supportsSupervisedProviderChildLocation,
  chatProgram,
  launchCheck: { resolveLaunch: chatProgram.resolve, minimumVersions: TRAEX_MINIMUM_VERSIONS },
  resolveAccountHome: async ({ launchEnv }) =>
    agentSessionAccountHome(TRAEX_STRUCTURED_AGENT, traexPrivateHome(launchEnv)),
  modelCatalog: (context) => ({
    kind: 'probe',
    listingNamesConfiguredModel: false,
    probe: createTraexModelCatalogProbe(context)
  }),
  ...TRAEX_CLI_CONVERSATIONS
}
