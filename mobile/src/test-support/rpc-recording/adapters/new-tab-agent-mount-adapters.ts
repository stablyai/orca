import { operationModuleLoader } from '../operation-module-loader'
import type { MountAdapter } from '../recording-scenario'
import type * as NewTabAgentLoader from '../../../session/agent-launch/mobile-new-tab-agent-loader'

export function newTabAgentMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'settings.new-tab-agents': ({ client }) => {
      const loader = modules.load<typeof NewTabAgentLoader>(
        'mobile/src/session/agent-launch/mobile-new-tab-agent-loader.ts'
      )
      return {
        action: (_name, args) =>
          loader
            .loadMobileAgentLaunchContext({
              client,
              worktreeId: String(args.workspace ?? 'repo-1::/folder')
            })
            .then(({ settings, detectedAgents }) =>
              loader.newTabAgentOptionsFrom(settings, detectedAgents)
            ),
        state: () => ({}),
        dispose: () => {}
      }
    }
  }
}
