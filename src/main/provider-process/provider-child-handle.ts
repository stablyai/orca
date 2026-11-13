import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { finished } from 'node:stream/promises'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { ProviderChild } from './provider-child'
import { notifyRuntimeListeners } from '../runtime/events/runtime-listener-delivery'

/** Common stream/event surface for pending and directly spawned provider children. */
export abstract class ProviderChildHandle extends EventEmitter implements ProviderChild {
  pid: number | undefined
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  connected = false
  killed = false
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  rootAbsent = false
  spawnAbsenceKnown = false
  protected direct: ChildProcessWithoutNullStreams | null = null
  protected settled = false
  protected closed = false
  protected resolveReady!: () => void
  protected rejectReady!: (error: Error) => void
  readonly ready = new Promise<void>((resolve, reject) => {
    this.resolveReady = resolve
    this.rejectReady = reject
  })

  constructor() {
    super()
    void this.ready.catch(() => {})
    for (const stream of [this.stdin, this.stdout, this.stderr]) {
      stream.on('error', () => {})
    }
  }

  abstract kill(signal?: NodeJS.Signals | number): boolean

  protected useDirectChild(child: ChildProcessWithoutNullStreams): void {
    this.direct = child
    this.pid = child.pid
    this.connected = child.connected
    this.stdin.pipe(child.stdin)
    child.stdout.pipe(this.stdout)
    child.stderr.pipe(this.stderr)
    child.on('message', (message) => this.emit('message', message))
    child.once('disconnect', () => this.endReport())
    child.once('spawn', () => {
      this.emit('spawn')
      this.resolveReady()
    })
    child.once('error', (error) => {
      this.spawnAbsenceKnown = child.pid === undefined
      this.rejectReady(error)
      this.notifyTerminal('error', error)
    })
    child.once('exit', (code, signal) => {
      this.settled = true
      this.exitCode = code
      this.signalCode = signal
      this.notifyTerminal('exit', code, signal)
    })
    child.once('close', (code, signal) => this.finishClose(code, signal))
  }

  protected endReport(): void {
    if (!this.connected) {
      return
    }
    this.connected = false
    this.notifyTerminal('disconnect')
  }

  protected notifyTerminal(event: string, ...args: unknown[]): void {
    notifyRuntimeListeners(
      this.rawListeners(event),
      (listener) => listener.apply(this, args),
      `provider ${event}`
    )
  }

  protected finishClose(code: number | null, signal: NodeJS.Signals | null, failure?: Error): void {
    if (this.closed) {
      return
    }
    this.closed = true
    const close = (error?: Error): void => {
      if (error) {
        this.notifyTerminal('error', error)
        this.stdout.destroy()
        this.stderr.destroy()
      }
      this.notifyTerminal('close', code, signal)
    }
    this.endReport()
    this.stdin.destroy()
    if (failure) {
      close(failure)
      return
    }
    const outputs = [this.stdout, this.stderr]
    const drained = Promise.all(
      outputs.map((stream) => finished(stream, { writable: false, cleanup: true }))
    )
    this.stdout.end()
    this.stderr.end()
    // Exit listeners get the same opportunity to attach readers as on an actual child.
    process.nextTick(() => {
      for (const stream of outputs) {
        if (
          stream.readableFlowing === null &&
          !stream.readableDidRead &&
          stream.listenerCount('data') === 0 &&
          stream.listenerCount('readable') === 0
        ) {
          stream.resume()
        }
      }
    })
    void drained.then(() => close(), close)
  }
}
