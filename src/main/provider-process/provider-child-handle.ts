import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { ProviderChild } from './provider-child'

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
    this.stdin.on('error', () => {})
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
      this.emit('error', error)
    })
    child.once('exit', (code, signal) => {
      this.settled = true
      this.exitCode = code
      this.signalCode = signal
      this.emit('exit', code, signal)
    })
    child.once('close', (code, signal) => this.finishClose(code, signal))
  }

  protected endReport(): void {
    if (!this.connected) {
      return
    }
    this.connected = false
    this.emit('disconnect')
  }

  protected finishClose(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.endReport()
    this.stdin.destroy()
    this.stdout.end()
    this.stderr.end()
    this.emit('close', code, signal)
  }
}
