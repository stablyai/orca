import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
import { GrowingByteBuffer } from '../../shared/growing-byte-buffer'
import { assertJsonTextStructureWithinLimits } from '../../shared/json-text-structure-limit'
import { findTransport, type RuntimeMetadata } from '../../shared/runtime-bootstrap'
import { isKeepaliveFrame, RuntimeRpcEnvelopeSchema } from './envelope-schema'
import { RuntimeClientError, type RuntimeRpcResponse } from './types'

const MAX_RUNTIME_RESPONSE_LINE_BYTES = 64 * 1024 * 1024
export const CLI_RUNTIME_JSON_STRUCTURE_LIMITS = {
  structuralTokens: 1_000_000,
  nestingDepth: 128
} as const

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
    const buffer = new GrowingByteBuffer()
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
      buffer.clear()
      if (result.ok === false) {
        socket.destroy()
        reject(result.error)
      } else {
        socket.end()
        resolve(result.response)
      }
    }

    socket.once('error', () => {
      finish({
        ok: false,
        error: new RuntimeClientError(
          'runtime_unavailable',
          'Could not connect to the running Orca app. Restart Orca and try again.'
        )
      })
    })
    // Why: a clean peer close (FIN, no 'error') before a terminal frame never
    // settles the promise, so the call would otherwise hang until the full
    // timeout fires. Reject promptly. finish() guards double-settle, so this
    // no-ops on the normal success/error paths that already called socket.end().
    socket.once('close', () => {
      finish({
        ok: false,
        error: new RuntimeClientError(
          'runtime_unavailable',
          'The Orca runtime closed the connection before responding. Restart Orca and try again.'
        )
      })
    })
    socket.on('data', (chunk: Buffer) => {
      if (settled) {
        return
      }
      buffer.append(chunk)
      // Why: the server may interleave `{"_keepalive":true}\n` frames with the
      // final success/failure frame to keep both idle timers alive during a
      // long-poll (see design doc §3.1). Read frames in a loop until we see a
      // terminal frame. Each keepalive refreshes the client-side timer so a
      // 10 min wait doesn't trip the 60 s default ceiling.
      let newlineIndex = buffer.indexOfByte(0x0a)
      while (newlineIndex !== -1 && !settled) {
        const lineBytes = newlineIndex
        if (lineBytes > MAX_RUNTIME_RESPONSE_LINE_BYTES) {
          finish({
            ok: false,
            error: new RuntimeClientError(
              'invalid_runtime_response',
              `The Orca runtime response exceeded the ${MAX_RUNTIME_RESPONSE_LINE_BYTES} byte frame limit.`
            )
          })
          return
        }
        const line = buffer.takePrefixString(lineBytes)
        buffer.discardPrefix(1)
        if (line.trim().length === 0) {
          newlineIndex = buffer.indexOfByte(0x0a)
          continue
        }

        let raw: unknown
        try {
          assertJsonTextStructureWithinLimits(line, CLI_RUNTIME_JSON_STRUCTURE_LIMITS)
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
          newlineIndex = buffer.indexOfByte(0x0a)
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
          newlineIndex = buffer.indexOfByte(0x0a)
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
      if (buffer.byteLength > MAX_RUNTIME_RESPONSE_LINE_BYTES) {
        finish({
          ok: false,
          error: new RuntimeClientError(
            'invalid_runtime_response',
            `The Orca runtime response exceeded the ${MAX_RUNTIME_RESPONSE_LINE_BYTES} byte frame limit.`
          )
        })
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
