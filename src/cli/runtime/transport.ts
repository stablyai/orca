import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
import { findTransport, type RuntimeMetadata } from '../../shared/runtime-bootstrap'
import type {
  ExpectedRuntimeSource,
  RuntimeOrchestrationEnvelope,
  RuntimeRequestSelection
} from '../../shared/runtime-rpc-envelope'
import { isKeepaliveFrame, RuntimeRpcEnvelopeSchema } from './envelope-schema'
import { RuntimeClientError, RuntimeRpcFailureError, type RuntimeRpcResponse } from './types'
import { MAX_TIMER_DELAY_MS, isSafeTimerDelayMs } from '../../shared/timer-delay'
import { runtimeAccessDeniedError } from './runtime-access-denied'

export async function sendRequest<TResult>(
  metadata: RuntimeMetadata,
  method: string,
  params: unknown,
  timeoutMs: number,
  envelope?: RuntimeOrchestrationEnvelope,
  // Federation forwards envelopes; the runtime fence must stay local.
  expectedRuntimeSource?: ExpectedRuntimeSource,
  options: {
    classifySocketError?: (error: Error) => RuntimeClientError | null
    requestSelection?: RuntimeRequestSelection
  } = {}
): Promise<RuntimeRpcResponse<TResult>> {
  const { classifySocketError = runtimeAccessDeniedError, requestSelection } = options
  if (!isSafeTimerDelayMs(timeoutMs)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Runtime request timeout must be an integer between 0 and ${MAX_TIMER_DELAY_MS}ms.`
    )
  }
  return await new Promise((resolve, reject) => {
    const transport = findTransport(metadata, 'unix', 'named-pipe')
    if (!transport) {
      reject(
        new RuntimeClientError(
          'runtime_unavailable',
          'No compatible transport found in Orca runtime metadata.'
        )
      )
      return
    }
    const socket = createConnection(transport.endpoint)
    let lineSegments: string[] = []
    let settled = false
    const requestId = randomUUID()
    const statusRequestId = requestSelection ? randomUUID() : null
    let awaitingStatus = statusRequestId !== null
    let selectedParams = params

    const timeout = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      lineSegments = []
      socket.destroy()
      reject(
        new RuntimeClientError(
          'runtime_timeout',
          'Timed out waiting for the Orca runtime to respond.'
        )
      )
    }, timeoutMs)

    const finish = (
      result: { ok: true; response: RuntimeRpcResponse<TResult> } | { ok: false; error: Error }
    ): void => {
      if (settled) {
        return
      }
      settled = true
      lineSegments = []
      clearTimeout(timeout)
      socket.end()
      if (result.ok === false) {
        reject(result.error)
      } else {
        resolve(result.response)
      }
    }

    socket.setEncoding('utf8')
    socket.once('error', (error) => {
      finish({
        ok: false,
        // Access denial does not establish that the app is dead.
        error:
          classifySocketError(error) ??
          new RuntimeClientError(
            'runtime_unavailable',
            'This terminal could not connect to Orca.',
            { nextSteps: ['Check that Orca is open and that this terminal can access it.'] }
          )
      })
    })
    // A clean close without a terminal frame must reject rather than wait for the timeout.
    socket.once('close', () => {
      finish({
        ok: false,
        error: new RuntimeClientError(
          'runtime_unavailable',
          'Orca closed the connection before responding.',
          { nextSteps: ['Check that Orca is open and that this terminal can access it.'] }
        )
      })
    })
    socket.on('data', (chunk: string) => {
      let cursor = 0
      while (cursor < chunk.length && !settled) {
        const newlineIndex = chunk.indexOf('\n', cursor)
        if (newlineIndex === -1) {
          lineSegments.push(chunk.slice(cursor))
          return
        }
        const segment = chunk.slice(cursor, newlineIndex)
        let line = segment
        if (lineSegments.length > 0) {
          lineSegments.push(segment)
          line = lineSegments.join('')
          lineSegments = []
        }
        cursor = newlineIndex + 1
        if (line.trim().length === 0) {
          continue
        }

        let raw: unknown
        try {
          raw = JSON.parse(line)
        } catch {
          finish({
            ok: false,
            error: new RuntimeClientError(
              'invalid_runtime_response',
              'The Orca runtime returned an invalid response frame.'
            )
          })
          return
        }

        // Keepalives refresh the idle timeout without a full envelope validation.
        if (isKeepaliveFrame(raw)) {
          timeout.refresh()
          continue
        }

        // Validate the envelope at the boundary; callers remain responsible for TResult’s shape.
        const parsed = RuntimeRpcEnvelopeSchema.safeParse(raw)
        if (!parsed.success) {
          finish({
            ok: false,
            error: new RuntimeClientError(
              'invalid_runtime_response',
              'The Orca runtime returned an invalid response frame.'
            )
          })
          return
        }

        const frame = parsed.data
        if ('_keepalive' in frame) {
          timeout.refresh()
          continue
        }

        const response = frame as RuntimeRpcResponse<TResult>
        if (response.id !== (awaitingStatus ? statusRequestId : requestId)) {
          finish({
            ok: false,
            error: new RuntimeClientError(
              'invalid_runtime_response',
              'The Orca runtime returned a mismatched response id.'
            )
          })
          return
        }
        if (response._meta?.runtimeId && response._meta.runtimeId !== metadata.runtimeId) {
          finish({
            ok: false,
            error: new RuntimeClientError(
              'runtime_unavailable',
              'The Orca runtime changed while the request was in flight.',
              { nextSteps: ['Retry the command.'] }
            )
          })
          return
        }
        if (awaitingStatus) {
          try {
            if (frame.ok === false) {
              throw new RuntimeRpcFailureError(frame)
            }
            selectedParams = requestSelection?.paramsForStatus(frame.result)
          } catch (error) {
            finish({ ok: false, error: error instanceof Error ? error : new Error(String(error)) })
            return
          }
          awaitingStatus = false
          send(requestId, method, selectedParams)
          continue
        }
        finish({ ok: true, response })
        return
      }
    })
    const send = (id: string, requestedMethod: string, requestedParams: unknown): void => {
      try {
        const serialized = `${JSON.stringify({
          id,
          authToken: metadata.authToken,
          method: requestedMethod,
          params: requestedParams,
          orchestrationCapability: envelope?.orchestrationCapability,
          orchestrationContractVersion: envelope?.orchestrationContractVersion,
          orchestrationRequestId: envelope?.orchestrationRequestId,
          compatibilityInvocationId: envelope?.compatibilityInvocationId,
          orchestrationCompatibilityEvidence: envelope?.orchestrationCompatibilityEvidence,
          expectedRuntimeSource
        })}\n`
        if (id === requestId) {
          requestSelection?.onDispatch?.()
        }
        socket.write(serialized)
      } catch (error) {
        finish({ ok: false, error: error instanceof Error ? error : new Error(String(error)) })
      }
    }
    socket.on('connect', () => {
      send(
        statusRequestId ?? requestId,
        statusRequestId ? 'status.get' : method,
        statusRequestId ? undefined : params
      )
    })
  })
}
