import { connect, constants, type ClientHttp2Session } from 'node:http2'
import { readApnsStreamResponse, type ApnsResponse } from './apns-stream-response.js'

export type ApnsRequest = {
  host: string
  path: string
  headers: Record<string, string>
  body: string
}

export type { ApnsResponse }
export type ApnsTransport = (request: ApnsRequest) => Promise<ApnsResponse>

// APNs requires HTTP/2 and rewards a long-lived session per host, so sessions
// are cached and only dropped when the socket itself goes away.
export function createApnsHttp2Transport(): ApnsTransport & { close(): void } {
  const sessions = new Map<string, ClientHttp2Session>()

  const sessionFor = (host: string): ClientHttp2Session => {
    const existing = sessions.get(host)
    if (existing && !existing.closed && !existing.destroyed) return existing
    const session = connect(`https://${host}`)
    session.on('error', () => sessions.delete(host))
    session.on('close', () => sessions.delete(host))
    sessions.set(host, session)
    return session
  }

  const transport = async (request: ApnsRequest): Promise<ApnsResponse> => {
    const stream = sessionFor(request.host).request({
      ...request.headers,
      [constants.HTTP2_HEADER_METHOD]: 'POST',
      [constants.HTTP2_HEADER_PATH]: request.path,
      [constants.HTTP2_HEADER_AUTHORITY]: request.host,
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(request.body))
    })
    return await readApnsStreamResponse(stream, request.body)
  }

  return Object.assign(transport, {
    close(): void {
      for (const session of sessions.values()) session.close()
      sessions.clear()
    }
  })
}
