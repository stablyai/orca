import { connect, type Socket } from 'node:net'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

export class BunWebSocketUpgradeProxy {
  private readonly downstreams = new Set<Duplex>()
  private readonly upstreams = new Set<Socket>()
  private stopped = false

  constructor(private readonly targetPort: number) {}

  handle(request: IncomingMessage, downstream: Duplex, head: Buffer): void {
    if (this.stopped) {
      downstream.destroy()
      return
    }
    const upstream = connect({ host: '127.0.0.1', port: this.targetPort })
    this.downstreams.add(downstream)
    this.upstreams.add(upstream)
    const destroyPair = (): void => {
      downstream.destroy()
      upstream.destroy()
    }
    downstream.once('error', destroyPair)
    downstream.once('close', () => {
      this.downstreams.delete(downstream)
      upstream.destroy()
    })
    upstream.once('error', destroyPair)
    upstream.once('close', () => {
      this.upstreams.delete(upstream)
      downstream.destroy()
    })
    upstream.once('connect', () => {
      if (this.stopped || downstream.destroyed) {
        destroyPair()
        return
      }
      upstream.write(serializeUpgradeRequest(request), 'latin1')
      if (head.byteLength > 0) {
        upstream.write(head)
      }
      downstream.pipe(upstream)
      upstream.pipe(downstream)
    })
  }

  stop(): void {
    this.stopped = true
    for (const downstream of this.downstreams) {
      downstream.destroy()
    }
    for (const upstream of this.upstreams) {
      upstream.destroy()
    }
    this.downstreams.clear()
    this.upstreams.clear()
  }
}

export function serializeUpgradeRequest(request: IncomingMessage): string {
  const start = `${request.method ?? 'GET'} ${request.url ?? '/'} HTTP/${request.httpVersion}`
  const headers: string[] = []
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    headers.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1] ?? ''}`)
  }
  return `${start}\r\n${headers.join('\r\n')}\r\n\r\n`
}
