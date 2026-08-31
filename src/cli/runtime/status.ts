import type { CliStatusResult, RuntimeStatus } from '../../shared/runtime-types'
import { findTransport } from '../../shared/runtime-bootstrap'
import { tryReadMetadata } from './metadata'
import { sendRequest } from './transport'
import {
  projectRemoteAppStatus,
  resolveDesktopWindowStatus
} from '../../shared/cli-app-status-projection'
import { RuntimeRpcFailureError, type RuntimeRpcSuccess } from './types'
import { classifyLocalRuntimeUnreachable } from './local-runtime-unreachable-reason'

const STATUS_REQUEST_TIMEOUT_MS = 1000

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
    const response = await sendRequest<RuntimeStatus>(
      metadata,
      'status.get',
      undefined,
      STATUS_REQUEST_TIMEOUT_MS
    )
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
  } catch (error) {
    const running = isProcessRunning(metadata.pid)
    if (!running) {
      return buildCliStatusResponse({
        app: { running: false, pid: null },
        runtime: { state: 'stale_bootstrap', reachable: false, runtimeId: null },
        graph: { state: 'not_running' }
      })
    }
    // Why: STA-3969 — metadata naming this endpoint is only written after the
    // runtime's transport is listening, so a live app plus a failed request is a
    // reachability failure, never a start in progress. Report the cause.
    return buildCliStatusResponse({
      app: { running: true, pid: metadata.pid },
      runtime: {
        state: 'unreachable',
        reachable: false,
        runtimeId: null,
        unreachableReason: classifyLocalRuntimeUnreachable(
          error,
          transport,
          STATUS_REQUEST_TIMEOUT_MS
        )
      },
      graph: { state: 'unreachable' }
    })
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
