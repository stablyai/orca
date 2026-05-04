import { createConnection } from 'net'
import { randomUUID } from 'crypto'
import type { RuntimeMetadata, RuntimeTransportMetadata } from '../../shared/runtime-bootstrap'
import { RuntimeRpcEnvelopeSchema } from './envelope-schema'
import { RuntimeClientError, type RuntimeRpcResponse } from './types'

export async function sendRequest<TResult>(
  metadata: RuntimeMetadata,
  method: string,
  params: unknown,
  timeoutMs: number
): Promise<RuntimeRpcResponse<TResult>> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(getTransportEndpoint(metadata.transport!))
    let buffer = ''
    const requestId = randomUUID()

    const timeout = setTimeout(() => {
      socket.destroy()
      reject(
        new RuntimeClientError(
          'runtime_timeout',
          'Timed out waiting for the Orca runtime to respond.'
        )
      )
    }, timeoutMs)

    socket.setEncoding('utf8')
    socket.once('error', () => {
      clearTimeout(timeout)
      reject(
        new RuntimeClientError(
          'runtime_unavailable',
          'Could not connect to the running Orca app. Restart Orca and try again.'
        )
      )
    })
    socket.on('data', (chunk) => {
      buffer += chunk
      const newlineIndex = buffer.indexOf('\n')
      if (newlineIndex === -1) {
        return
      }
      const message = buffer.slice(0, newlineIndex)
      socket.end()
      clearTimeout(timeout)
      let response: RuntimeRpcResponse<TResult>
      try {
        const raw: unknown = JSON.parse(message)
        // Why: validate the envelope shape (id, ok, result/error, _meta) at
        // the decode boundary so version skew between the CLI and the Orca
        // main runtime surfaces as a single invalid_runtime_response instead
        // of a downstream mis-typed field access. `result` is left as
        // unknown — the TResult generic is the caller's responsibility.
        const parsed = RuntimeRpcEnvelopeSchema.safeParse(raw)
        if (!parsed.success) {
          reject(
            new RuntimeClientError(
              'invalid_runtime_response',
              'The Orca runtime returned an invalid response frame.'
            )
          )
          return
        }
        response = parsed.data as RuntimeRpcResponse<TResult>
      } catch {
        reject(
          new RuntimeClientError(
            'invalid_runtime_response',
            'The Orca runtime returned an invalid response frame.'
          )
        )
        return
      }
      if (response.id !== requestId) {
        reject(
          new RuntimeClientError(
            'invalid_runtime_response',
            'The Orca runtime returned a mismatched response id.'
          )
        )
        return
      }
      if (response._meta?.runtimeId && response._meta.runtimeId !== metadata.runtimeId) {
        reject(
          new RuntimeClientError(
            'runtime_unavailable',
            'The Orca runtime changed while the request was in flight. Retry the command.'
          )
        )
        return
      }
      resolve(response)
    })
    socket.on('connect', () => {
      socket.write(
        `${JSON.stringify({
          id: requestId,
          authToken: metadata.authToken,
          method,
          params
        })}\n`
      )
    })
  })
}

function getTransportEndpoint(transport: RuntimeTransportMetadata): string {
  return transport.endpoint
}
