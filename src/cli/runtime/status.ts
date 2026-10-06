import type { CliStatusResult, RuntimeStatus } from '../../shared/runtime-types'
import { runtimeHostConnectionState } from '../../shared/runtime-host-connection-state'
import { findTransport } from '../../shared/runtime-bootstrap'
import { tryReadMetadata } from './metadata'
import { sendRequest } from './transport'
import {
  projectRemoteAppStatus,
  resolveDesktopWindowStatus
} from '../../shared/cli-app-status-projection'
import { RuntimeClientError, RuntimeRpcFailureError, type RuntimeRpcSuccess } from './types'
import { isProcessRunning } from './runtime-pid-liveness'

export { projectRemoteAppStatus, resolveDesktopWindowStatus }

export async function getCliStatus(
  userDataPath: string,
  verifyStatus?: (status: RuntimeStatus) => void
): Promise<RuntimeRpcSuccess<CliStatusResult>> {
  const metadata = tryReadMetadata(userDataPath)
  const transport = metadata ? findTransport(metadata, 'unix', 'named-pipe') : null
  if (!transport || !metadata?.authToken) {
    return buildCliStatusResponse({
      app: {
        running: false,
        pid: null
      },
      runtime: {
        // Why: distinguishing "never started" from "was running but died"
        // gives the user a better signal about what happened. If the metadata
        // file exists, Orca was running at some point.
        state: metadata ? 'stale_bootstrap' : 'not_running',
        reachable: false,
        runtimeId: null
      },
      graph: {
        state: 'not_running'
      }
    })
  }

  let status: RuntimeStatus
  try {
    const response = await sendRequest<RuntimeStatus>(metadata, 'status.get', undefined, 1000)
    if (response.ok === false) {
      throw new RuntimeRpcFailureError(response)
    }
    status = response.result
  } catch (error) {
    // Why: a denied caller cannot tell a live Orca from a dead one, so report the denial, not a state.
    if (error instanceof RuntimeClientError && error.code === 'runtime_access_denied') {
      throw error
    }
    const running = isProcessRunning(metadata.pid)
    return buildCliStatusResponse({
      app: {
        running,
        pid: running ? metadata.pid : null
      },
      runtime: {
        state: running ? 'starting' : 'stale_bootstrap',
        reachable: false,
        connectionState: 'disconnected',
        runtimeId: null
      },
      graph: {
        state: running ? 'starting' : 'not_running'
      }
    })
  }
  // Why: outside the try so a blocked protocol window is reported, not read as a starting runtime.
  verifyStatus?.(status)
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
        status
      }),
      runtimeId: status.runtimeId,
      ...(status.appVersion ? { appVersion: status.appVersion } : {}),
      ...runtimeProtocolWindow(status),
      ...(status.remoteUpdateSupport ? { remoteUpdateSupport: status.remoteUpdateSupport } : {}),
      ...(status.capabilities ? { capabilities: status.capabilities } : {}),
      ...(status.degradations ? { degradations: status.degradations } : {})
    },
    graph: {
      state: graphState
    }
  })
}

// Why: older runtimes publish only the legacy mobile-named fields, so fall back like the compat gate.
export function runtimeProtocolWindow(
  status: RuntimeStatus
): Pick<
  CliStatusResult['runtime'],
  'runtimeProtocolVersion' | 'minCompatibleRuntimeClientVersion'
> {
  const protocol = status.runtimeProtocolVersion ?? status.protocolVersion
  const minClient = status.minCompatibleRuntimeClientVersion ?? status.minCompatibleMobileVersion
  return {
    ...(protocol !== undefined ? { runtimeProtocolVersion: protocol } : {}),
    ...(minClient !== undefined ? { minCompatibleRuntimeClientVersion: minClient } : {})
  }
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
