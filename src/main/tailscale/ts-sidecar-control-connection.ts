import type { Duplex } from 'stream'
import { createNdjsonParser, encodeNdjson } from '../daemon/ndjson'

export type { TailscaleNodeState, TailscaleStatus } from '../../shared/tailscale-status'
import type { TailscaleStatus } from '../../shared/tailscale-status'

type PendingRequest = {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
}

// Why: the request/response correlation and event demultiplexing over the
// sidecar's NDJSON socket is pure stream logic. Keeping it independent of how
// the socket is created (a real net.Socket in production, a fake Duplex in
// tests) lets the protocol be verified without spawning the Go binary.
export class SidecarControlConnection {
  private readonly pending = new Map<string, PendingRequest>()
  private nextId = 0
  private closed = false
  private readonly parser = createNdjsonParser(
    (msg) => this.handleMessage(msg),
    (err) => this.onParseError?.(err)
  )

  constructor(
    private readonly stream: Duplex,
    private readonly token: string,
    private readonly onState?: (status: TailscaleStatus) => void,
    private readonly onParseError?: (err: Error) => void
  ) {
    stream.on('data', (chunk: Buffer) => this.parser.feed(chunk.toString('utf8')))
    stream.on('close', () => this.failAll(new Error('tailnet sidecar connection closed')))
    stream.on('error', (err: Error) => this.failAll(err))
  }

  /** Send a request and resolve with its `result` payload, or reject on a
   *  non-ok response, a closed connection, or the timeout. */
  request(type: string, timeoutMs = 30_000): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error('tailnet sidecar connection is closed'))
    }
    const id = String(++this.nextId)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`tailnet sidecar request '${type}' timed out after ${timeoutMs}ms`))
        }
      }, timeoutMs)
      const settle: PendingRequest = {
        resolve: (result) => {
          clearTimeout(timer)
          resolve(result)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        }
      }
      this.pending.set(id, settle)
      this.stream.write(encodeNdjson({ id, type, token: this.token }))
    })
  }

  async hello(): Promise<void> {
    await this.request('hello')
  }

  status(): Promise<TailscaleStatus> {
    return this.request('status') as Promise<TailscaleStatus>
  }

  up(): Promise<TailscaleStatus> {
    return this.request('up') as Promise<TailscaleStatus>
  }

  down(): Promise<TailscaleStatus> {
    return this.request('down') as Promise<TailscaleStatus>
  }

  dispose(): void {
    this.failAll(new Error('tailnet sidecar connection disposed'))
  }

  private handleMessage(msg: unknown): void {
    if (!msg || typeof msg !== 'object') {
      return
    }
    const record = msg as Record<string, unknown>
    if (record.type === 'event') {
      if (record.event === 'state' && this.onState) {
        this.onState(record.payload as TailscaleStatus)
      }
      return
    }
    const id = typeof record.id === 'string' ? record.id : undefined
    if (!id) {
      return
    }
    const entry = this.pending.get(id)
    if (!entry) {
      return
    }
    this.pending.delete(id)
    if (record.ok === true) {
      entry.resolve(record.result)
    } else {
      entry.reject(
        new Error(typeof record.error === 'string' ? record.error : 'tailnet sidecar error')
      )
    }
  }

  private failAll(err: Error): void {
    this.closed = true
    for (const [, entry] of this.pending) {
      entry.reject(err)
    }
    this.pending.clear()
  }
}
