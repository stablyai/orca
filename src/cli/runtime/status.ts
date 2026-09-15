import type { CliStatusResult } from '../../shared/runtime-types'
import { runtimeHostConnectionState } from '../../shared/runtime-host-connection-state'
import { findTransport } from '../../shared/runtime-bootstrap'
import { tryReadMetadata } from './metadata'
import {
  projectRemoteAppStatus,
  resolveDesktopWindowStatus
} from '../../shared/cli-app-status-projection'
import { RuntimeClientError, type RuntimeRpcSuccess } from './types'
import {
  observeLocalProcess,
  statusObservationError,
  observeRuntimeStatus
} from './status-observation'

export { projectRemoteAppStatus, resolveDesktopWindowStatus }

export async function getCliStatus(
  userDataPath: string
): Promise<RuntimeRpcSuccess<CliStatusResult>> {
  const metadata = tryReadMetadata(userDataPath)
  const transport = metadata ? findTransport(metadata, 'unix', 'named-pipe') : null
  if (!transport || !metadata?.authToken) {
    const processObservation = metadata ? observeLocalProcess(metadata.pid) : null
    if (processObservation && processObservation !== 'exited') {
      throw statusObservationError(
        processObservation,
        new RuntimeClientError('runtime_unavailable', 'Runtime metadata is incomplete.')
      )
    }
    return buildCliStatusResponse({
      app: {
        running: false,
        pid: null
      },
      runtime: {
        // Stale bootstrap requires positive local PID absence, not failed observation.
        state: metadata ? 'stale_bootstrap' : 'not_running',
        reachable: false,
        runtimeId: null
      },
      graph: {
        state: 'not_running'
      }
    })
  }

  const status = await observeRuntimeStatus(metadata)
  if (status) {
    const graphState = status.graphStatus
    const desktopWindowStatus = resolveDesktopWindowStatus(status)
    return buildCliStatusResponse({
      app: {
        running: true,
        pid: metadata.pid,
        ...(desktopWindowStatus ? { desktopWindowStatus } : {})
      },
      runtime: {
        state: graphState === 'ready' ? 'ready' : 'graph_not_ready',
        reachable: true,
        connectionState: runtimeHostConnectionState({
          hasStatusEntry: true,
          status: status
        }),
        runtimeId: status.runtimeId,
        ...(status.appVersion ? { appVersion: status.appVersion } : {}),
        ...(status.remoteUpdateSupport ? { remoteUpdateSupport: status.remoteUpdateSupport } : {}),
        ...(status.capabilities ? { capabilities: status.capabilities } : {}),
        ...(status.degradations ? { degradations: status.degradations } : {})
      },
      graph: {
        state: graphState
      }
    })
  }
  return buildCliStatusResponse({
    app: {
      running: false,
      pid: null
    },
    runtime: {
      state: 'stale_bootstrap',
      reachable: false,
      connectionState: 'disconnected',
      runtimeId: null
    },
    graph: {
      state: 'not_running'
    }
  })
}

function buildCliStatusResponse(result: CliStatusResult): RuntimeRpcSuccess<CliStatusResult> {
  return {
    id: 'local-status',
    ok: true,
    result: { target: { kind: 'local' }, ...result },
    _meta: {
      runtimeId: result.runtime.runtimeId ?? 'none'
    }
  }
}
