import { EventEmitter } from 'node:events'
import { StringDecoder } from 'node:string_decoder'

/** Output of a worker child; the worker throttles it through output-consumed, so it always flows. */
export class WorkerThreadChildOutput extends EventEmitter {
  private decoder: StringDecoder | null = null

  setEncoding(encoding: BufferEncoding): this {
    this.decoder = new StringDecoder(encoding)
    return this
  }

  resume(): this {
    return this
  }

  push(chunk: Buffer): void {
    const data = this.decoder ? this.decoder.write(chunk) : chunk
    if (data.length > 0) {
      this.emit('data', data)
    }
  }

  flush(): void {
    const rest = this.decoder?.end()
    if (rest) {
      this.emit('data', rest)
    }
  }
}
