import type { Writable } from 'node:stream'

type Write = {
  line: string
  resolve: () => void
  reject: (error: Error) => void
  detachAbort?: () => void
}

export class ProviderStdioWriteQueue {
  private readonly queue: Write[] = []
  private bytes = 0
  private active?: Write
  private terminalError?: Error
  private detachDrain?: () => void

  constructor(
    private readonly output: Writable,
    private readonly maxBytes: number,
    private readonly onFailure: (error: Error) => void,
    private readonly errors: { capacity: () => Error; closed: () => Error }
  ) {}

  write(line: string, signal?: AbortSignal): Promise<void> {
    if (this.terminalError) {
      return Promise.reject(this.terminalError)
    }
    if (signal?.aborted) {
      return Promise.reject(signal.reason)
    }
    const bytes = Buffer.byteLength(line)
    if (this.bytes + bytes > this.maxBytes) {
      return Promise.reject(this.errors.capacity())
    }
    this.bytes += bytes
    return new Promise((resolve, reject) => {
      const write: Write = { line, resolve, reject }
      const abort = (): void => {
        // Why: a line already handed to the stream can't be taken back, and later writes wait on it.
        if (this.active === write) {
          this.onFailure(
            signal?.reason instanceof Error ? signal.reason : new Error('Agent write aborted')
          )
          return
        }
        const index = this.queue.indexOf(write)
        if (index === -1) {
          return
        }
        this.queue.splice(index, 1)
        this.bytes -= bytes
        write.detachAbort?.()
        reject(signal?.reason)
      }
      signal?.addEventListener('abort', abort, { once: true })
      write.detachAbort = () => signal?.removeEventListener('abort', abort)
      this.queue.push(write)
      this.flush()
    })
  }

  close(error: Error): void {
    if (this.terminalError) {
      return
    }
    this.terminalError = error
    this.detachDrain?.()
    this.detachDrain = undefined
    this.active?.detachAbort?.()
    this.active?.reject(error)
    this.active = undefined
    for (const write of this.queue.splice(0)) {
      write.detachAbort?.()
      write.reject(error)
    }
    this.bytes = 0
  }

  private flush(): void {
    if (this.active || this.terminalError) {
      return
    }
    const write = this.queue.shift()
    if (!write) {
      return
    }
    this.active = write
    if (this.output.destroyed || !this.output.writable) {
      this.onFailure(this.errors.closed())
      return
    }
    let completed = false
    let drained = false
    let returned = false
    const finish = (): void => {
      if (!returned || !completed || !drained || this.terminalError) {
        return
      }
      this.detachDrain?.()
      this.detachDrain = undefined
      write.detachAbort?.()
      this.active = undefined
      this.bytes -= Buffer.byteLength(write.line)
      write.resolve()
      this.flush()
    }
    const onDrain = (): void => {
      drained = true
      finish()
    }
    this.output.once('drain', onDrain)
    this.detachDrain = () => this.output.removeListener('drain', onDrain)
    try {
      const accepted = this.output.write(write.line, (error) => {
        if (error) {
          this.onFailure(error)
          return
        }
        completed = true
        finish()
      })
      drained ||= accepted
      returned = true
      finish()
    } catch (error) {
      this.onFailure(error instanceof Error ? error : new Error(String(error)))
    }
  }
}
