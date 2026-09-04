import type { EventEmitter } from 'node:events'
import { constants } from 'node:http2'

export type ApnsResponse = { status: number; body: string }

// The subset of ClientHttp2Stream this module drives, so a fake emitter can
// stand in for a real APNs stream in tests.
export type ApnsResponseStream = EventEmitter & {
  setTimeout(ms: number, callback: () => void): void
  destroy(error?: Error): void
  end(body: string): void
}

export const APNS_REQUEST_TIMEOUT_MS = 10_000

export function readApnsStreamResponse(
  stream: ApnsResponseStream,
  body: string,
  timeoutMs = APNS_REQUEST_TIMEOUT_MS
): Promise<ApnsResponse> {
  return new Promise<ApnsResponse>((resolve, reject) => {
    let settled = false
    const settle = (run: () => void): void => {
      if (settled) return
      settled = true
      run()
    }
    let status = 0
    const chunks: Buffer[] = []
    stream.setTimeout(timeoutMs, () => stream.destroy(new Error('apns_timeout')))
    stream.on('response', (headers: Record<string, unknown>) => {
      status = Number(headers[constants.HTTP2_HEADER_STATUS] ?? 0)
    })
    stream.on('data', (chunk: Buffer) => chunks.push(chunk))
    stream.on('error', (error: Error) => settle(() => reject(error)))
    stream.on('end', () =>
      settle(() => resolve({ status, body: Buffer.concat(chunks).toString('utf8') }))
    )
    // A peer reset with NGHTTP2_NO_ERROR emits neither 'end' nor 'error', which
    // would leave the coalescer's delivery pending for the life of the process.
    stream.on('close', () => settle(() => reject(new Error('apns_stream_closed'))))
    stream.end(body)
  })
}
