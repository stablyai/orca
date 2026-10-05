import type { MountAdapter } from '../recording-scenario'
import type { operationModuleLoader } from '../operation-module-loader'

const WORKSPACE = 'workspace-1'

/**
 * Opening a structured agent chat: the support probe, its bounded selector retry, and the durable
 * create the phone replays exactly once when the transport drops.
 *
 * Recorded rather than reasoned about because every failure here has to stay `unknown` rather than
 * `failed` unless the host names the refusal definitive — a create that may have committed must not
 * grow a sibling terminal. The replay makes that visible as two sends for one action.
 */
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
