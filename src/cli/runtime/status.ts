import type { CliStatusResult, RuntimeStatus } from '../../shared/runtime-types'
import { runtimeHostConnectionState } from '../../shared/runtime-host-connection-state'
import { findTransport } from '../../shared/runtime-bootstrap'
import { tryReadMetadata } from './metadata'
import { sendRequest } from './transport'
import {
  projectRemoteAppStatus,
  resolveDesktopWindowStatus
} from '../../shared/cli-app-status-projection'
import { RuntimeRpcFailureError, type RuntimeRpcSuccess } from './types'

/** A live process still inside this window may honestly be `starting`. Past it, status.get
 * failing means the runtime is not accepting commands, not that boot is still in progress. */
export const RUNTIME_STARTING_GRACE_MS = 15_000

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
    const response = await sendRequest<RuntimeStatus>(metadata, 'status.get', undefined, 1000)
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
        ...(response.result.degradations ? { degradations: response.result.degradations } : {}),
        ...(response.result.worktreeHydration
          ? { worktreeHydration: response.result.worktreeHydration }
          : {})
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
        state: running ? unreachableLiveRuntimeState(metadata.startedAt) : 'stale_bootstrap',
        reachable: false,
        connectionState: 'disconnected',
        runtimeId: null
      },
      graph: {
        state: running
          ? unreachableLiveRuntimeState(metadata.startedAt) === 'unresponsive'
            ? 'unavailable'
            : 'starting'
          : 'not_running'
      }
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

function unreachableLiveRuntimeState(
  startedAt: number | null | undefined
): 'starting' | 'unresponsive' {
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) {
    return 'starting'
  }
  return Date.now() - startedAt > RUNTIME_STARTING_GRACE_MS ? 'unresponsive' : 'starting'
}

function isProcessRunning(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // Why: only ESRCH proves the pid is gone. EPERM means it exists under another uid, and
    // reporting that as `stale_bootstrap` calls a live Orca dead.
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
  }
}
