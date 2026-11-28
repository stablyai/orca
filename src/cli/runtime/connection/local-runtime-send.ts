import type { RuntimeMetadata } from '../../../shared/remote-runtime/bootstrap/runtime-bootstrap'
import type {
  RuntimeOrchestrationEnvelope,
  RuntimeRequestSelection,
  RuntimeRpcResponse
} from '../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { readMetadata } from '../profile/metadata'
import { isRequestUnsent } from './client-error-recovery'
import { runtimeAccessDeniedError } from './runtime-access-denied'
import {
  isConnectFailureCode,
  RUNTIME_GRAPH_READY_FIRST_POLL_MS,
  type RuntimeRestartWait
} from './runtime-restart-wait'
import {
  runtimeNotRunningError,
  runtimeRestartedSincePreflightError,
  runtimeRestartingError
} from './runtime-restarting-error'
import { isProcessRunning } from './runtime-pid-liveness'
import type { RuntimeSourceFence } from './runtime-source-fence'
import { sendRequest } from './transport'
import { RuntimeClientError } from './types'

export type LocalRuntimeRequest = {
  userDataPath: string
  fence: RuntimeSourceFence
  restartWait: RuntimeRestartWait
  method: string
  params: unknown
  timeoutMs: number
  envelope: RuntimeOrchestrationEnvelope
  requestSelection?: RuntimeRequestSelection | undefined
  /** Refuse, unsent, to send to any other runtime than this one. */
  pinnedRuntimeId?: string | null | undefined
  /** Attaches mutation recovery to a failure that may have reached the runtime. */
  recover: (error: unknown, runtimeId: string | null) => unknown
}

/** Sends to the local runtime, waiting out an announced restart while nothing has been sent. */
export async function sendLocalRuntimeRequest<TResult>(
  request: LocalRuntimeRequest
): Promise<{ metadata: RuntimeMetadata; response: RuntimeRpcResponse<TResult> }> {
  const { restartWait } = request
  const retryDuringRestart = async (error: unknown) =>
    isUnavailable(error) && (await restartWait.shouldRetry())
  const restartingOr = (error: unknown) =>
    restartWait.restart && isUnavailable(error)
      ? runtimeRestartingError(restartWait.restart)
      : error
  let graphPollMs = RUNTIME_GRAPH_READY_FIRST_POLL_MS
  for (;;) {
    let metadata: RuntimeMetadata
    try {
      metadata = readMetadata(request.userDataPath)
    } catch (error) {
      if (await retryDuringRestart(error)) {
        continue
      }
      throw restartingOr(error)
    }
    // A request shaped by an earlier answer must not reach a replacement that may lack what it saw.
    const pin =
      request.pinnedRuntimeId ??
      (restartWait.restart && request.method !== 'status.get' ? restartWait.servedBy : null)
    if (pin && metadata.runtimeId !== pin) {
      // Refuse once; the caller's rerun starts over against the new runtime.
      restartWait.servedBy = null
      throw runtimeRestartedSincePreflightError()
    }
    let expectedRuntimeSource
    try {
      // Refusal precedes sending, so there is no request to recover.
      expectedRuntimeSource = await request.fence.check(metadata, request.method)
    } catch (error) {
      // The fence probe is a read-only status call, so retrying it is always safe.
      if (await retryDuringRestart(error)) {
        continue
      }
      if (!restartWait.restart && isUnavailable(error) && !isProcessRunning(metadata.pid)) {
        throw runtimeNotRunningError()
      }
      throw restartingOr(error)
    }
    // After waiting out a restart, send only once the new runtime's graph serves, so the request isn't refused.
    if (
      restartWait.restart &&
      request.method !== 'status.get' &&
      !(await isGraphReady(metadata)) &&
      (await restartWait.pause(graphPollMs))
    ) {
      graphPollMs = Math.min(graphPollMs * 2, 1_000)
      continue
    }
    let socketErrorCode: unknown
    try {
      const response = await sendRequest<TResult>(
        metadata,
        request.method,
        request.params,
        request.timeoutMs,
        request.envelope,
        expectedRuntimeSource,
        {
          classifySocketError: (socketError) => {
            socketErrorCode = 'code' in socketError ? socketError.code : undefined
            return runtimeAccessDeniedError(socketError)
          },
          ...(request.requestSelection ? { requestSelection: request.requestSelection } : {})
        }
      )
      if (request.method === 'status.get') {
        restartWait.noteAnsweredBy(metadata.runtimeId)
      } else {
        restartWait.settle(metadata.runtimeId)
      }
      return { metadata, response }
    } catch (error) {
      // Only a refused connect proves nothing was sent; a dropped request may have applied.
      if (isConnectFailureCode(socketErrorCode)) {
        if (await retryDuringRestart(error)) {
          continue
        }
        if (restartWait.restart) {
          throw restartingOr(error)
        }
        // Stale metadata from an app that exited: say plainly it isn't running, not "busy, retry".
        if (!isProcessRunning(metadata.pid)) {
          throw runtimeNotRunningError()
        }
      }
      // A pre-send refusal has no outcome to recover; retry advice would resend the same bytes.
      throw isRequestUnsent(error) ? error : request.recover(error, metadata.runtimeId ?? null)
    }
  }
}

async function isGraphReady(metadata: RuntimeMetadata): Promise<boolean> {
  try {
    const status = await sendRequest<{ graphStatus?: RuntimeStatus['graphStatus'] }>(
      metadata,
      'status.get',
      { probe: true },
      1000
    )
    // Runtimes that predate graphStatus in the probe can't say; send as before.
    return status.ok && (status.result.graphStatus ?? 'ready') === 'ready'
  } catch {
    return false
  }
}

function isUnavailable(error: unknown): boolean {
  return error instanceof RuntimeClientError && error.code === 'runtime_unavailable'
}
