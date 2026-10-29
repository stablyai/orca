import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
import { findTransport, type RuntimeMetadata } from '../../shared/runtime-bootstrap'
import type {
  ExpectedRuntimeSource,
  RuntimeOrchestrationEnvelope
} from '../../shared/runtime-rpc-envelope'
import { isKeepaliveFrame, RuntimeRpcEnvelopeSchema } from './envelope-schema'
import { RuntimeClientError, type RuntimeRpcResponse } from './types'
import { MAX_TIMER_DELAY_MS, isSafeTimerDelayMs } from '../../shared/timer-delay'
import { runtimeAccessDeniedError } from './runtime-access-denied'

export async function sendRequest<TResult>(
  metadata: RuntimeMetadata,
  method: string,
  params: unknown,
  timeoutMs: number,
  envelope?: RuntimeOrchestrationEnvelope,
  // Federation forwards envelopes; the runtime fence must stay local.
  expectedRuntimeSource?: ExpectedRuntimeSource
): Promise<RuntimeRpcResponse<TResult>> {
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
          runtimeAccessDeniedError(error, metadata.pid) ??
          new RuntimeClientError(
            'runtime_unavailable',
            'Could not connect to the running Orca app. Restart Orca and try again.'
          )
      })
    })
    // A clean close without a terminal frame must reject rather than wait for the timeout.
    socket.once('close', () => {
      finish({
        ok: false,
        error: new RuntimeClientError(
          'runtime_unavailable',
          'The Orca runtime closed the connection before responding. Restart Orca and try again.'
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
        if (response.id !== requestId) {
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
              'The Orca runtime changed while the request was in flight. Retry the command.'
            )
          })
          return
        }
        finish({ ok: true, response })
        return
      }
    })
    socket.on('connect', () => {
      socket.write(
        `${JSON.stringify({
          id: requestId,
          authToken: metadata.authToken,
          method,
          params,
          orchestrationCapability: envelope?.orchestrationCapability,
          orchestrationContractVersion: envelope?.orchestrationContractVersion,
          orchestrationRequestId: envelope?.orchestrationRequestId,
          compatibilityInvocationId: envelope?.compatibilityInvocationId,
          orchestrationCompatibilityEvidence: envelope?.orchestrationCompatibilityEvidence,
          expectedRuntimeSource
        })}\n`
      )
    })
  })
}
