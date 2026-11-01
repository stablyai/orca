import { operationModuleLoader } from '../operation-module-loader'
import type { MountAdapter } from '../recording-scenario'

export function newTabAgentMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'settings.new-tab-agents': ({ client }) => {
      const load = modules.load<typeof import('../../../session/mobile-new-tab-agent-loader')>(
        'mobile/src/session/mobile-new-tab-agent-loader.ts'
      ).loadMobileNewTabAgentOptions
      return {
        action: (_name, args) =>
          load({ client, worktreeId: String(args.workspace ?? 'repo-1::/folder') }).then(
            ({ options }) => options
          ),
        state: () => ({}),
        dispose: () => {}
      }
    }
  }
}
