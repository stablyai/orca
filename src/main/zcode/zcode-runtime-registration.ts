// The ZCode row in the structured-session registry: its adapter, location support,
// and the account home its chats pin.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { agentSessionAccountHome } from '../../shared/agent-session-account-home'
import { supportsSupervisedProviderChildLocation } from '../provider-process/supervised-provider-child-location'
import type { StructuredAgentRuntimeRegistration } from '../runtime/structured-agent-runtime-registrations'
import { ZcodeStructuredSessionAdapter } from './zcode-structured-session-adapter'
import { ZCODE_STRUCTURED_AGENT } from './zcode-structured-agent-definition'
import { createZcodeStructuredLaunchResolver } from './zcode-structured-launch-resolution'

function createZcodeAdapter(
  context: Parameters<StructuredAgentRuntimeRegistration['createAdapter']>[0]
) {
  const { deps, store } = context
  return new ZcodeStructuredSessionAdapter({
    resolveLaunch: createZcodeStructuredLaunchResolver({
      store,
      resolveWorkspacePath: deps.resolveWorkspacePath,
      resolveEnvironment: context.environment.resolveBaseEnvironment,
      ...(deps.resolveZcodeCommand ? { resolveCommand: deps.resolveZcodeCommand } : {})
    }),
    ...(deps.openZcodeConnection ? { openConnection: deps.openZcodeConnection } : {}),
    ...(deps.readProcessStartTime ? { readProcessStartTime: deps.readProcessStartTime } : {}),
    logger: deps.logger,
    // Zcode's ended events always carry a cause, so lifecycle forwards whole.
    onEvent: context.deliverLifecycle
  })
}

export const ZCODE_RUNTIME_REGISTRATION: StructuredAgentRuntimeRegistration = {
  definition: ZCODE_STRUCTURED_AGENT,
  createAdapter: createZcodeAdapter,
  supportsLocation: (location) => supportsSupervisedProviderChildLocation(location),
  resolveAccountHome: async ({ launchEnv }) =>
    agentSessionAccountHome(
      ZCODE_STRUCTURED_AGENT,
      launchEnv.ZCODE_HOME?.trim() || join(homedir(), '.zcode')
    )
}
