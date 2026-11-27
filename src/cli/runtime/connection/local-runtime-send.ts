import type { RuntimeMetadata } from '../../../shared/remote-runtime/bootstrap/runtime-bootstrap'
import type {
  RuntimeOrchestrationEnvelope,
  RuntimeRequestSelection,
  RuntimeRpcResponse
} from '../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { readMetadata } from '../profile/metadata'
import { isRequestUnsent } from './client-error-recovery'
import { runtimeAccessDeniedError } from './runtime-access-denied'
import { isConnectFailureCode, type RuntimeRestartWait } from './runtime-restart-wait'
import { runtimeRestartingError } from './runtime-restarting-error'
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
    // Refusal precedes sending, so there is no request to recover.
    const expectedRuntimeSource = await request.fence.check(metadata, request.method)
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
            socketErrorCode = (socketError as NodeJS.ErrnoException).code
            return runtimeAccessDeniedError(socketError)
          },
          ...(request.requestSelection ? { requestSelection: request.requestSelection } : {})
        }
      )
      restartWait.settle()
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
      }
      // A pre-send refusal has no outcome to recover; retry advice would resend the same bytes.
      throw isRequestUnsent(error) ? error : request.recover(error, metadata.runtimeId ?? null)
    }
  }
}

function isUnavailable(error: unknown): boolean {
  return error instanceof RuntimeClientError && error.code === 'runtime_unavailable'
}
