import { createConnection } from 'net'
import { randomUUID } from 'crypto'
import { findTransport, type RuntimeMetadata } from '../../shared/runtime-bootstrap'
import { isKeepaliveFrame, RuntimeRpcEnvelopeSchema } from './envelope-schema'
import { RuntimeClientError, type RuntimeRpcResponse } from './types'

export async function sendRequest<TResult>(
  metadata: RuntimeMetadata,
  method: string,
  params: unknown,
  timeoutMs: number
): Promise<RuntimeRpcResponse<TResult>> {
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
    let buffer = ''
    let settled = false
    const requestId = randomUUID()

    const timeout = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
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
      clearTimeout(timeout)
      socket.end()
      if (result.ok) {
        resolve(result.response)
      } else {
        reject(result.error)
      }
    }

    socket.setEncoding('utf8')
    socket.once('error', () => {
      finish({
        ok: false,
        error: new RuntimeClientError(
          'runtime_unavailable',
          'Could not connect to the running Orca app. Restart Orca and try again.'
        )
      })
    })
    socket.on('data', (chunk) => {
      buffer += chunk
      // Why: the server may interleave `{"_keepalive":true}\n` frames with the
      // final success/failure frame to keep both idle timers alive during a
      // long-poll (see design doc §3.1). Read frames in a loop until we see a
      // terminal frame. Each keepalive refreshes the client-side timer so a
      // 10 min wait doesn't trip the 60 s default ceiling.
      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex !== -1 && !settled) {
        const line = buffer.slice(0, newlineIndex)
        buffer = buffer.slice(newlineIndex + 1)
        if (line.trim().length === 0) {
          newlineIndex = buffer.indexOf('\n')
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

        // Fast-path: ignore keepalives without running the full schema.
        // setTimeout().refresh() is stable since Node 10 (Orca ships on
        // Node 20+ via Electron and the standalone CLI targets the same
        // major). See §7 risk #9.
        if (isKeepaliveFrame(raw)) {
          timeout.refresh()
          newlineIndex = buffer.indexOf('\n')
          continue
        }

        // Why: validate the envelope shape (id, ok, result/error, _meta) at
        // the decode boundary so version skew between the CLI and the Orca
        // main runtime surfaces as a single invalid_runtime_response instead
        // of a downstream mis-typed field access. `result` is left as
        // unknown — the TResult generic is the caller's responsibility.
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

        // Narrow out keepalive (already filtered above) so TS can see a
        // Success|Failure shape here.
        const frame = parsed.data
        if ('_keepalive' in frame) {
          timeout.refresh()
          newlineIndex = buffer.indexOf('\n')
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
          params
        })}\n`
      )
    })
  })
}
