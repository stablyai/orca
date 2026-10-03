/** LSP base-protocol framing: `Content-Length: N\r\n\r\n<N bytes of JSON>`. */

const HEADER_TERMINATOR = '\r\n\r\n'
// Why: a corrupt or hostile length header must not make us buffer without bound.
const MAX_BODY_BYTES = 64 * 1024 * 1024

export function encodeContentLengthMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body])
}

/** Incremental decoder: feed stdout chunks, get back complete JSON messages. */
export class ContentLengthMessageDecoder {
  private buffer: Buffer = Buffer.alloc(0)
  private expectedBodyLength: number | null = null

  push(chunk: Buffer): unknown[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const messages: unknown[] = []
    for (;;) {
      if (this.expectedBodyLength === null) {
        const headerEnd = this.buffer.indexOf(HEADER_TERMINATOR)
        if (headerEnd === -1) {
          return messages
        }
        const header = this.buffer.subarray(0, headerEnd).toString('ascii')
        const lengthMatch = /content-length:\s*(\d+)/i.exec(header)
        this.buffer = this.buffer.subarray(headerEnd + HEADER_TERMINATOR.length)
        if (!lengthMatch) {
          // Why: a headerless frame means the stream is corrupt; skipping it and
          // resynchronizing on the next header loses one message, not the session.
          continue
        }
        const length = Number(lengthMatch[1])
        if (length > MAX_BODY_BYTES) {
          this.buffer = Buffer.alloc(0)
          throw new Error('Language server frame exceeds the size limit')
        }
        this.expectedBodyLength = length
      }
      if (this.buffer.length < this.expectedBodyLength) {
        return messages
      }
      const body = this.buffer.subarray(0, this.expectedBodyLength).toString('utf8')
      this.buffer = this.buffer.subarray(this.expectedBodyLength)
      this.expectedBodyLength = null
      try {
        messages.push(JSON.parse(body))
      } catch {
        // Why: one malformed body shouldn't kill the whole session stream.
      }
    }
  }
}
