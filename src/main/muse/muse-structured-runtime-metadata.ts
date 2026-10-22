import { homedir } from 'node:os'
import { agentSessionAccountHome } from '../../shared/agent-session-account-home'
import type { StructuredAgentRuntimeMetadata } from '../runtime/structured-agent-runtime-registration-types'
import { MUSE_STRUCTURED_AGENT } from './muse-structured-agent-definition'
import { MUSE_SESSION_HISTORY } from './muse-session-history'
import { createMuseModelCatalogProbe } from './muse-model-catalog'
import { supportsMuseStructuredLocation } from './muse-structured-location-support'
import type { StructuredAgentCommandSettings } from '../native-chat/structured-agent-command-resolution'
import {
  resolveMuseCommand,
  supportsMuseStructuredVersion
} from './muse-structured-launch-resolution'

export const MUSE_STRUCTURED_RUNTIME_METADATA: StructuredAgentRuntimeMetadata = {
  definition: MUSE_STRUCTURED_AGENT,
  modelCatalog: (context) => ({
    kind: 'probe',
    listingNamesConfiguredModel: false,
    probe: createMuseModelCatalogProbe({
      resolveEnvironment: () => context.environment.resolveAgentEnvironment('muse'),
      refreshEnvironmentAfterMiss: context.environment.refreshAfterMissingProgram
    })
  }),
  transcriptImport: null,
  sessionHistory: MUSE_SESSION_HISTORY,
  supportsLocation: supportsMuseStructuredLocation,
  launchCheck: {
    resolveLaunch: (
      env: Record<string, string>,
      commandSettings?: StructuredAgentCommandSettings
    ) => {
      const homePath = env.HOME ?? env.USERPROFILE ?? homedir()
      return { command: resolveMuseCommand(env, commandSettings), env: { ...env, HOME: homePath } }
    },
    supportsVersion: (version: string) => supportsMuseStructuredVersion(version)
  },
  resolveAccountHome: async ({ launchEnv }) =>
    agentSessionAccountHome(
      MUSE_STRUCTURED_AGENT,
      launchEnv.HOME ?? launchEnv.USERPROFILE ?? homedir()
    )
}
