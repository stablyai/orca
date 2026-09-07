import { closeSync, openSync } from 'node:fs'
import { RelayDispatcher } from './dispatcher'
import { RELAY_SENTINEL } from './protocol'

export class RelayPrimaryChannel {
  readonly dispatcher: RelayDispatcher
  private stdoutAlive = true
  private readonly stdoutDrainWaiters = new Set<() => void>()

  constructor() {
    process.stdout.on('drain', this.flushStdoutDrainWaiters)
    this.dispatcher = new RelayDispatcher(
      (data, onSettled) => {
        if (!this.stdoutAlive) {
          onSettled({ ok: false, error: new Error('Relay stdout is closed') })
          return false
        }
        try {
          return process.stdout.write(data, (error) => {
            onSettled(error ? { ok: false, error } : { ok: true })
          })
        } catch (error) {
          this.stdoutAlive = false
          this.flushStdoutDrainWaiters()
          onSettled({
            ok: false,
            error: error instanceof Error ? error : new Error(String(error))
          })
          return false
        }
      },
      {
        supportsWriteCallback: true,
        writableLength: () => process.stdout.writableLength,
        writableHighWaterMark: () => process.stdout.writableHighWaterMark,
        waitWriteDrain: (callback) => {
          if (!this.stdoutAlive) {
            callback()
            return
          }
          this.stdoutDrainWaiters.add(callback)
          return () => this.stdoutDrainWaiters.delete(callback)
        },
        close: () => this.closePrimaryDescriptors()
      },
      undefined,
      { pauseReads: () => process.stdin.pause(), resumeReads: () => process.stdin.resume() }
    )
  }

  get isAlive(): boolean {
    return this.stdoutAlive
  }

  detachInput(): void {
    process.stdin.pause()
    process.stdin.removeAllListeners('data')
  }

  startOutputFailureHandling(): void {
    process.stdout.on('error', () => {
      this.markClosed('peer-closed')
    })
  }

  startInput(callbacks: { onData: () => void; onDisconnect: (reason: string) => void }): void {
    process.stdin.on('data', (chunk: Buffer) => {
      callbacks.onData()
      this.dispatcher.feed(chunk)
    })
    process.stdin.on('end', () => {
      this.markClosed('peer-closed')
      callbacks.onDisconnect('stdin ended')
    })
    process.stdin.on('error', () => {
      this.markClosed('peer-closed')
      callbacks.onDisconnect('stdin error')
    })
  }

  writeSentinel(): void {
    this.dispatcher.writePrimaryBytes(Buffer.from(RELAY_SENTINEL))
  }

  detachPrimaryClient(): void {
    this.stdoutAlive = false
    this.flushStdoutDrainWaiters()
    this.dispatcher.invalidateClient()
  }

  private readonly flushStdoutDrainWaiters = (): void => {
    for (const callback of Array.from(this.stdoutDrainWaiters)) {
      this.stdoutDrainWaiters.delete(callback)
      callback()
    }
  }

  private markClosed(cause: 'peer-closed'): void {
    this.stdoutAlive = false
    this.flushStdoutDrainWaiters()
    this.dispatcher.invalidateClient(cause)
  }

  private closePrimaryDescriptors(): void {
    this.stdoutAlive = false
    this.flushStdoutDrainWaiters()
    for (const fd of [process.stdin.fd, process.stdout.fd]) {
      try {
        closeSync(fd)
      } catch {
        // Already closed by the peer.
      }
    }
    const devNull = process.platform === 'win32' ? 'NUL' : '/dev/null'
    try {
      openSync(devNull, 'r')
    } catch {
      // Best-effort pin of the lowest free descriptor.
    }
    try {
      openSync(devNull, 'w')
    } catch {
      // Best-effort pin of the next free descriptor.
    }
  }
}
