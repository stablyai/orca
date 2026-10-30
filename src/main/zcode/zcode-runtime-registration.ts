// The ZCode row in the structured-session catalog: its metadata and adapter factory.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { agentSessionAccountHome } from '../../shared/agent-session-account-home'
import { supportsSupervisedProviderChildLocation } from '../provider-process/supervised-provider-child-location'
import {
  composeStructuredLaunch,
  structuredAgentLaunchSources
} from '../runtime/structured-agent-launch-composition'
import type {
  StructuredAgentAdapterContext,
  StructuredAgentRuntimeAdapter,
  StructuredAgentRuntimeMetadata
} from '../runtime/structured-agent-runtime-registration-types'
import { ZcodeStructuredSessionAdapter } from './zcode-structured-session-adapter'
import { ZCODE_STRUCTURED_AGENT } from './zcode-structured-agent-definition'
import {
  resolveZcodeChatProgram,
  zcodeStructuredLaunchPart
} from './zcode-structured-launch-resolution'
import { ZCODE_CLI_CONVERSATIONS } from './zcode-cli-conversations'

export const ZCODE_RUNTIME_METADATA: StructuredAgentRuntimeMetadata = {
  definition: ZCODE_STRUCTURED_AGENT,
  // The app-server lists models only inside a conversation; no session-free listing exists.
  modelCatalog: () => ({
    kind: 'unavailable',
    reason: 'zcode app-server lists no models without a session'
  }),
  ...ZCODE_CLI_CONVERSATIONS,
  chatProgram: {
    resolve: (env, commandSettings) => resolveZcodeChatProgram(env, commandSettings)
  },
  supportsLocation: (location) => supportsSupervisedProviderChildLocation(location),
  resolveAccountHome: async ({ launchEnv }) =>
    agentSessionAccountHome(
      ZCODE_STRUCTURED_AGENT,
      launchEnv.ZCODE_HOME?.trim() || join(homedir(), '.zcode')
    )
}

export function createZcodeAdapter(
  context: StructuredAgentAdapterContext
): StructuredAgentRuntimeAdapter {
  const { deps } = context
  return new ZcodeStructuredSessionAdapter({
    resolveLaunch: composeStructuredLaunch(
      ZCODE_STRUCTURED_AGENT,
      structuredAgentLaunchSources(context),
      zcodeStructuredLaunchPart({ resolveInvocation: deps.resolveZcodeInvocation })
    ),
    ...(deps.openZcodeConnection ? { openConnection: deps.openZcodeConnection } : {}),
    ...(deps.readProcessStartTime ? { readProcessStartTime: deps.readProcessStartTime } : {}),
    logger: deps.logger,
    // Zcode's ended events always carry a cause, so lifecycle forwards whole.
    onEvent: context.deliverLifecycle
  })
}
