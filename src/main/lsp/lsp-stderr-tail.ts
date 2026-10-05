import type { Readable } from 'node:stream'

const STDERR_TAIL_CHARS = 4_096
const STDERR_FLUSH_MS = 500

/** Keeps the last few KB of a server's stderr so a failed start can say why. */
export class LspStderrTail {
  private tail = ''

  constructor(private readonly stream: Readable) {
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => {
      this.tail = (this.tail + chunk).slice(-STDERR_TAIL_CHARS)
    })
  }

  /** Calls back once stderr has drained, or after a short wait if a grandchild still holds it. */
  whenFlushed(callback: (tail: string) => void): void {
    let done = false
    const flush = (): void => {
      if (!done) {
        done = true
        clearTimeout(timer)
        callback(this.tail.trim())
      }
    }
    const timer = setTimeout(flush, STDERR_FLUSH_MS)
    if (this.stream.readableEnded || this.stream.destroyed) {
      flush()
    } else {
      this.stream.once('close', flush)
    }
  }
}
