import type { CliStatusResult, RuntimeStatus } from '../../shared/runtime-types'
import { tryReadMetadata } from './metadata'
import { sendRequest } from './transport'
import { RuntimeRpcFailureError, type RuntimeRpcSuccess } from './types'

export async function getCliStatus(
  userDataPath: string
): Promise<RuntimeRpcSuccess<CliStatusResult>> {
  const metadata = tryReadMetadata(userDataPath)
  if (!metadata?.transport || !metadata.authToken) {
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

  try {
    const response = await sendRequest<RuntimeStatus>(metadata, 'status.get', undefined, 1000)
    if (!response.ok) {
      throw new RuntimeRpcFailureError(response)
    }
    const graphState = response.result.graphStatus
    return buildCliStatusResponse({
      app: {
        running: true,
        pid: metadata.pid
      },
      runtime: {
        state: graphState === 'ready' ? 'ready' : 'graph_not_ready',
        reachable: true,
        runtimeId: response.result.runtimeId
      },
      graph: {
        state: graphState
      }
    })
  } catch {
    const running = isProcessRunning(metadata.pid)
    return buildCliStatusResponse({
      app: {
        running,
        pid: running ? metadata.pid : null
      },
      runtime: {
        state: running ? 'starting' : 'stale_bootstrap',
        reachable: false,
        runtimeId: null
      },
      graph: {
        state: running ? 'starting' : 'not_running'
      }
    })
  }
}

function buildCliStatusResponse(result: CliStatusResult): RuntimeRpcSuccess<CliStatusResult> {
  return {
    id: 'local-status',
    ok: true,
    result,
    _meta: {
      runtimeId: result.runtime.runtimeId ?? 'none'
    }
  }
}

function isProcessRunning(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
