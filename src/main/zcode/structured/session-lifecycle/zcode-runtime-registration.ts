import type {
  StructuredAgentAdapterContext,
  StructuredAgentRuntimeAdapter
} from '../../../runtime/agent-session/installation/structured-agent-runtime-registration-types'
import {
  composeStructuredLaunch,
  structuredAgentLaunchSources
} from '../../../runtime/agent-session/launch/structured-agent-launch-composition'
import { ZcodeStructuredSessionAdapter } from './zcode-structured-session-adapter'
import { ZcodeAtRestCommandCatalog } from '../catalog/zcode-at-rest-commands'
import { ZcodeNamingRuns } from '../naming/zcode-naming-run'
import { zcodeStructuredLaunchPart } from '../launch/zcode-structured-launch-resolution'
import { ZCODE_STRUCTURED_AGENT } from '../launch/zcode-structured-agent-definition'
import { resolveZcodeChatCredentials } from '../credentials/zcode-chat-credentials'

/** The runtime registration's zcode adapter: one app-server child per chat, PR-owned wiring. */
export function createZcodeAdapter(
  context: StructuredAgentAdapterContext
): StructuredAgentRuntimeAdapter {
  const { deps } = context
  return new ZcodeStructuredSessionAdapter({
    resolveCommandSettings: deps.resolveAgentCommandSettings,
    // Disposable fork/rewind backends need the same per-agent overlay a live chat launch gets.
    resolveEnvironment: () => context.environment.resolveAgentEnvironment('zcode'),
    atRestCommands: new ZcodeAtRestCommandCatalog({
      resolveEnvironment: () => context.environment.resolveAgentEnvironment('zcode'),
      resolveCommandSettings: deps.resolveAgentCommandSettings,
      resolveWorkspacePath: deps.resolveWorkspacePath
    }),
    namingRuns: new ZcodeNamingRuns({
      resolveEnvironment: () => context.environment.resolveAgentEnvironment('zcode'),
      resolveCommandSettings: deps.resolveAgentCommandSettings,
      resolveChatCredentials: () =>
        resolveZcodeChatCredentials({ site: deps.resolveZcodeChatPlanSite?.() })
    }),
    resolveLaunch: composeStructuredLaunch(
      ZCODE_STRUCTURED_AGENT,
      structuredAgentLaunchSources(context),
      zcodeStructuredLaunchPart({
        resolveLaunchArgs: () => deps.resolveLaunchArgs('zcode')
      })
    ),
    resolveChatCredentials: () =>
      resolveZcodeChatCredentials({ site: deps.resolveZcodeChatPlanSite?.() }),
    logger: deps.logger,
    onEvent: (event) => {
      // The lifecycle arms carry the fence; the translator's plain `ended` is diagnostics only.
      if ('fence' in event) {
        context.deliverLifecycle(event)
      }
    },
    onDispatchSettledLate: (settlement) => context.followUps.onDispatchSettledLate(settlement)
  })
}
