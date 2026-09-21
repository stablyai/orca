import { randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'
import { z } from 'zod'
import { findTransport, type RuntimeMetadata } from '../../shared/runtime-bootstrap'
import { BROWSER_UNAVAILABLE_ERROR_CODE } from '../../shared/runtime-types'
import { BrowserError } from '../browser/browser-error'
const SIDECAR_MAX_RESPONSE_BYTES = 64 * 1024 * 1024

const RuntimeResponse = z.discriminatedUnion('ok', [
  z.object({ id: z.string(), ok: z.literal(true), result: z.unknown() }).passthrough(),
  z
    .object({
      id: z.string(),
      ok: z.literal(false),
      error: z.object({ code: z.string(), message: z.string() }).passthrough()
    })
    .passthrough()
])

export async function sendOrcadSidecarRequest(
  metadata: RuntimeMetadata,
  method: string,
  params: unknown,
  timeoutMs = 90_000
): Promise<unknown> {
  const transport = findTransport(metadata, 'unix', 'named-pipe')
  if (!transport) {
    throw new BrowserError(
      BROWSER_UNAVAILABLE_ERROR_CODE,
      'Electron browser sidecar has no local RPC transport.'
    )
  }
  return await new Promise((resolve, reject) => {
    const socket = createConnection(transport.endpoint)
    const requestId = randomUUID()
    let buffer = ''
    let retainedBytes = 0
    let settled = false
    const finish = (error: Error | null, result?: unknown): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      socket.end()
      if (error) {
        reject(error)
      } else {
        resolve(result)
      }
    }
    const timer = setTimeout(() => {
      socket.destroy()
      finish(new BrowserError('browser_timeout', 'Electron browser sidecar request timed out.'))
    }, timeoutMs)
    timer.unref?.()
    socket.setEncoding('utf8')
    socket.once('error', () => {
      finish(
        new BrowserError(
          BROWSER_UNAVAILABLE_ERROR_CODE,
          'Could not connect to Electron browser sidecar.'
        )
      )
    })
    socket.once('close', () => {
      finish(
        new BrowserError(
          BROWSER_UNAVAILABLE_ERROR_CODE,
          'Electron browser sidecar closed before responding.'
        )
      )
    })
    socket.on('data', (chunk: string) => {
      buffer += chunk
      retainedBytes += Buffer.byteLength(chunk, 'utf8')
      if (retainedBytes > SIDECAR_MAX_RESPONSE_BYTES) {
        socket.destroy()
        finish(new BrowserError('browser_error', 'Electron browser sidecar response is too large.'))
        return
      }
      let newline = buffer.indexOf('\n')
      while (newline !== -1 && !settled) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        retainedBytes = Buffer.byteLength(buffer, 'utf8')
        newline = buffer.indexOf('\n')
        if (!line.trim()) {
          continue
        }
        let raw: unknown
        try {
          raw = JSON.parse(line)
        } catch {
          finish(
            new BrowserError('browser_error', 'Electron browser sidecar returned invalid JSON.')
          )
          return
        }
        if (raw && typeof raw === 'object' && '_keepalive' in raw) {
          timer.refresh()
          continue
        }
        const parsed = RuntimeResponse.safeParse(raw)
        if (!parsed.success || parsed.data.id !== requestId) {
          finish(
            new BrowserError(
              'browser_error',
              'Electron browser sidecar returned an invalid response.'
            )
          )
          return
        }
        if (!parsed.data.ok) {
          finish(new BrowserError(parsed.data.error.code, parsed.data.error.message))
          return
        }
        finish(null, parsed.data.result)
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
