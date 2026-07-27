import type { CliStatusResult, RuntimeStatus } from '../../shared/runtime-types'
import { resolveDesktopWindowStatus } from './status'
import type { RuntimeRpcSuccess } from './types'

/**
 * Maps a paired runtime's `status.get` response into the CLI status shape. Remote
 * status proves the runtime is reachable, not that this machine runs a local Orca,
 * so `app.running` is always false here.
 */
export function buildRemoteCliStatusResult(
  response: RuntimeRpcSuccess<RuntimeStatus>
): RuntimeRpcSuccess<CliStatusResult> {
  const graphState = response.result.graphStatus
  return {
    id: response.id,
    ok: true,
    result: {
      app: {
        running: false,
        pid: null,
        // Why: reuse the shared resolver so remote status honors the same
        // authoritativeWindowId fallback as local status for old runtimes.
        ...(() => {
          const desktopWindowStatus = resolveDesktopWindowStatus(response.result)
          return desktopWindowStatus ? { desktopWindowStatus } : {}
        })()
      },
      runtime: {
        state: graphState === 'ready' ? 'ready' : 'graph_not_ready',
        reachable: true,
        runtimeId: response.result.runtimeId,
        ...(response.result.appVersion ? { appVersion: response.result.appVersion } : {}),
        ...(response.result.remoteUpdateSupport
          ? { remoteUpdateSupport: response.result.remoteUpdateSupport }
          : {}),
        ...(response.result.capabilities ? { capabilities: response.result.capabilities } : {})
      },
      graph: {
        state: graphState
      }
    },
    _meta: response._meta
  }
}
