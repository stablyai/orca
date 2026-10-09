import { Readable, Writable } from 'node:stream'
import type { ClientRequestConstructorOptions } from 'electron'
import { vi, type Mock } from 'vitest'

export class NativeHttpResponse extends Readable {
  statusCode: number
  statusMessage: string
  headers: Record<string, string | string[]>
  rawHeaders: string[]
  producedBytes = 0
  private remainingChunks = 0
  private chunkSize = 0

  constructor(status = 200, headers: Record<string, string | string[]> = {}) {
    super({ highWaterMark: 16 * 1024 })
    this.statusCode = status
    this.statusMessage = status === 200 ? 'OK' : ''
    this.headers = headers
    this.rawHeaders = Object.entries(headers).flatMap(([key, value]) =>
      (Array.isArray(value) ? value : [value]).flatMap((item) => [key, item])
    )
  }

  override _read(): void {
    if (this.remainingChunks > 0) {
      this.remainingChunks--
      this.producedBytes += this.chunkSize
      this.push(Buffer.alloc(this.chunkSize, 120))
      if (this.remainingChunks === 0) {
        this.push(null)
      }
    }
  }

  generate(chunks: number, chunkSize: number): void {
    this.remainingChunks = chunks
    this.chunkSize = chunkSize
  }

  send(value: string): void {
    this.push(Buffer.from(value))
  }

  finish(): void {
    this.push(null)
  }
}

export class NativeHttpRequest extends Writable {
  readonly chunks: Buffer[] = []
  readonly headers = new Map<string, string | string[]>()
  readonly responses: NativeHttpResponse[] = []
  chunkedEncoding = false
  holdWrites = false
  private pendingWriteCallbacks: (() => void)[] = []
  readonly abort: Mock<() => void> = vi.fn(() => {
    this.emit('abort')
    for (const response of this.responses) {
      response.destroy()
    }
    this.emit('close')
  })
  readonly followRedirect: Mock<() => void> = vi.fn()

  constructor(readonly options: ClientRequestConstructorOptions) {
    super({ highWaterMark: 16 * 1024 })
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
    this.chunks.push(Buffer.from(chunk))
    if (this.holdWrites) {
      this.pendingWriteCallbacks.push(callback)
    } else {
      callback()
    }
  }

  flushWrites(): void {
    this.holdWrites = false
    for (const callback of this.pendingWriteCallbacks.splice(0)) {
      callback()
    }
  }

  setHeader(name: string, value: string | string[]): void {
    this.headers.set(name.toLowerCase(), value)
  }

  getHeader(name: string): string | string[] | undefined {
    return this.headers.get(name.toLowerCase())
  }

  removeHeader(name: string): void {
    this.headers.delete(name.toLowerCase())
  }

  respond(status = 200, headers: Record<string, string | string[]> = {}): NativeHttpResponse {
    const response = new NativeHttpResponse(status, headers)
    this.responses.push(response)
    this.emit('response', response)
    return response
  }

  dispose(): void {
    this.flushWrites()
    this.destroy()
    for (const response of this.responses) {
      response.destroy()
    }
  }
}

export function deferred() {
  let finish = (): void => {}
  const promise = new Promise<void>((resolve) => {
    finish = resolve
  })
  return { promise, finish }
}
