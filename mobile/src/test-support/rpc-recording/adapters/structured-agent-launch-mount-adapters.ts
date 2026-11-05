import type { MountAdapter } from '../recording-scenario'
import type { operationModuleLoader } from '../operation-module-loader'

const WORKSPACE = 'workspace-1'

// Record probe/replay outcomes: a create that may have committed must remain unknown unless the host definitively refuses it.
export function structuredAgentLaunchMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'agentSession.structured-launch': ({ client }) => {
      const create = modules.load<
        typeof import('../../../session/mobile-structured-agent-session-launch')
      >(
        'mobile/src/session/mobile-structured-agent-session-launch.ts'
      ).createMobileStructuredAgentSession
      let launched: unknown = 'unlaunched'
      return {
        action: (name) =>
          create(client, WORKSPACE, name === 'codex' ? 'codex' : 'claude').then(
            (value: unknown) => {
              launched = value
              return value
            }
          ),
        state: () => ({ launched }),
        dispose: () => {}
      }
    }
  }
}
