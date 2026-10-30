import type { CliStatusResult, RuntimeStatus } from '../../shared/runtime-types'
import { runtimeHostConnectionState } from '../../shared/runtime-host-connection-state'
import { findTransport, type RuntimeMetadata } from '../../shared/runtime-bootstrap'
import { tryReadMetadata } from './metadata'
import { sendRequest } from './transport'
import {
  projectRemoteAppStatus,
  resolveDesktopWindowStatus
} from '../../shared/cli-app-status-projection'
import {
  RuntimeClientError,
  RuntimeRpcFailureError,
  type RuntimeRpcResponse,
  type RuntimeRpcSuccess
} from './types'
import { isProcessRunning } from './runtime-pid-liveness'
import { runtimeAccessDeniedError } from './runtime-access-denied'

export { projectRemoteAppStatus, resolveDesktopWindowStatus }

export async function getCliStatus(
  userDataPath: string
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
        // Existing metadata proves the runtime started at least once.
        state: metadata ? 'stale_bootstrap' : 'not_running',
        reachable: false,
        runtimeId: null
      },
      graph: {
        state: 'not_running'
      }
    })
  }

  const response = await sendRequest<RuntimeStatus>(metadata, 'status.get', undefined, 1000)
  return projectConnectedStatus(metadata, response)
}

export type OfflineRuntimeAdmission = {
  reachable: boolean
  legacyPidRunning: boolean
  pid: number | null
}

// Shipped offline commands retain their original admission policy, separate from connection truth.
export async function getOfflineRuntimeAdmission(
  userDataPath: string
): Promise<OfflineRuntimeAdmission> {
  const metadata = tryReadMetadata(userDataPath)
  const transport = metadata ? findTransport(metadata, 'unix', 'named-pipe') : null
  if (!transport || !metadata?.authToken) {
    return { reachable: false, legacyPidRunning: false, pid: null }
  }
  try {
    const response = await sendRequest<RuntimeStatus>(
      metadata,
      'status.get',
      undefined,
      1000,
      undefined,
      undefined,
      {
        classifySocketError: (error) => {
          const code = 'code' in error ? error.code : undefined
          return (code === 'EPERM' || code === 'EACCES') && isProcessRunning(metadata.pid)
            ? runtimeAccessDeniedError(error)
            : null
        }
      }
    )
    const status = projectConnectedStatus(metadata, response)
    return {
      reachable: status.result.runtime.reachable,
      legacyPidRunning: status.result.app.running,
      pid: status.result.app.pid ?? null
    }
  } catch (error) {
    if (error instanceof RuntimeClientError && error.code === 'runtime_access_denied') {
      throw error
    }
    const running = isProcessRunning(metadata.pid)
    return { reachable: false, legacyPidRunning: running, pid: running ? metadata.pid : null }
  }
}

function projectConnectedStatus(
  metadata: RuntimeMetadata,
  response: RuntimeRpcResponse<RuntimeStatus>
): RuntimeRpcSuccess<CliStatusResult> {
  if (response.ok === false) {
    throw new RuntimeRpcFailureError(response)
  }
  const graphState = response.result.graphStatus
  const desktopWindowStatus = resolveDesktopWindowStatus(response.result)
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
        status: response.result
      }),
      runtimeId: response.result.runtimeId,
      ...(response.result.appVersion ? { appVersion: response.result.appVersion } : {}),
      ...(response.result.remoteUpdateSupport
        ? { remoteUpdateSupport: response.result.remoteUpdateSupport }
        : {}),
      ...(response.result.capabilities ? { capabilities: response.result.capabilities } : {}),
      ...(response.result.degradations ? { degradations: response.result.degradations } : {})
    },
    graph: {
      state: graphState
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
