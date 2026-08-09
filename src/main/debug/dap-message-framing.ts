import { EventEmitter } from 'node:events'

/** Encodes a DAP message body as a `Content-Length`-framed buffer ready to write to an adapter's stdin. */
export function encodeDapMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const header = `Content-Length: ${body.length}\r\n\r\n`
  return Buffer.concat([Buffer.from(header, 'ascii'), body])
}

export class DapMessageFramingError extends Error {}

function parseContentLength(headerText: string): number | null {
  for (const line of headerText.split('\r\n')) {
    const match = /^Content-Length:\s*(\d+)$/i.exec(line.trim())
    if (match) {
      return Number(match[1])
    }
  }
  return null
}

/**
 * Streaming decoder for `Content-Length`-framed DAP messages. Feed raw stdout
 * chunks via `push`; emits `'message'` per decoded JSON body and `'error'` for
 * a header missing Content-Length or a body that fails to parse as JSON —
 * neither is fatal, the decoder keeps looking for the next message boundary.
 */
export class DapMessageDecoder extends EventEmitter {
  private buffer: Buffer = Buffer.alloc(0)
  private expectedBodyLength: number | null = null

  push(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    this.drain()
  }

  private drain(): void {
    for (;;) {
      if (this.expectedBodyLength === null) {
        const headerEnd = this.buffer.indexOf('\r\n\r\n')
        if (headerEnd === -1) {
          return
        }
        const headerText = this.buffer.subarray(0, headerEnd).toString('ascii')
        const contentLength = parseContentLength(headerText)
        this.buffer = this.buffer.subarray(headerEnd + 4)
        if (contentLength === null) {
          this.emit(
            'error',
            new DapMessageFramingError(
              `Malformed DAP header: missing Content-Length ("${headerText}")`
            )
          )
          continue
        }
        this.expectedBodyLength = contentLength
      }

      if (this.buffer.length < this.expectedBodyLength) {
        return
      }
      const bodyBuf = this.buffer.subarray(0, this.expectedBodyLength)
      this.buffer = this.buffer.subarray(this.expectedBodyLength)
      this.expectedBodyLength = null
      try {
        this.emit('message', JSON.parse(bodyBuf.toString('utf8')))
      } catch (err) {
        this.emit(
          'error',
          new DapMessageFramingError(`Malformed DAP body JSON: ${(err as Error).message}`)
        )
      }
    }
  }
}
