import { EventEmitter } from 'node:events'
import { Duplex, PassThrough, Readable, Writable } from 'node:stream'
import { ignoreProviderTransportError } from './provider-child'

type PipeDirection = 'read' | 'write' | 'duplex'
/** Native owner pipes by fd: output, control, gate, bootstrap status, outcome, then CLI input. */
const PIPE_DIRECTIONS: readonly (readonly [number, PipeDirection])[] = [
  [1, 'read'],
  [2, 'read'],
  [3, 'duplex'],
  [4, 'write'],
  [5, 'read'],
  [6, 'read'],
  [7, 'write']
]

/** Stands in for one owner pipe; EOF and destruction cross it exactly as on the pipe itself. */
class DeferredPipe {
  private readonly fromOwner = new PassThrough()
  private readonly toOwner = new PassThrough()
  readonly stream: Readable | Writable

  constructor(private readonly direction: PipeDirection) {
    this.stream =
      direction === 'read'
        ? this.fromOwner
        : direction === 'write'
          ? this.toOwner
          : Duplex.from({ readable: this.fromOwner, writable: this.toOwner })
  }

  attach(endpoint: Readable | Writable): void {
    endpoint.on('error', ignoreProviderTransportError)
    if (this.stream.destroyed) {
      endpoint.destroy()
      return
    }
    let ended = false
    endpoint.once('end', () => (ended = true))
    endpoint.once('close', () => {
      // Output still buffered here belongs to the consumer; only an abrupt close discards it.
      if (this.direction === 'write' ? !this.toOwner.readableEnded : !ended) {
        this.stream.destroy()
      }
    })
    this.stream.once('close', () => {
      // A finished write must flush first; its endpoint closes itself once flushed below.
      if (this.direction === 'read' || !this.toOwner.readableEnded) {
        endpoint.destroy()
      }
    })
    if (this.direction !== 'write' && endpoint instanceof Readable) {
      endpoint.pipe(this.fromOwner)
    }
    if (this.direction !== 'read' && endpoint instanceof Writable) {
      this.toOwner.pipe(endpoint)
    }
    if (this.direction === 'write') {
      endpoint.once('finish', () => endpoint.destroy())
    }
  }

  fail(): void {
    this.stream.destroy()
  }
}

/** The native owner process whose launch, by the host or this app, completes asynchronously. */
export class DeferredProviderOwner extends EventEmitter {
  pid: number | undefined
  readonly stdio: readonly (Readable | Writable | null)[]
  readonly stdout: Readable
  readonly stderr: Readable
  private readonly pipes = new Map<number, DeferredPipe>()
  private settled = false

  constructor() {
    super()
    for (const [fd, direction] of PIPE_DIRECTIONS) {
      this.pipes.set(fd, new DeferredPipe(direction))
    }
    this.stdio = [null, ...PIPE_DIRECTIONS.map(([fd]) => this.pipes.get(fd)!.stream)]
    this.stdout = this.fromOwner(1)
    this.stderr = this.fromOwner(2)
  }

  /** The owner already ended this launch by closing its gate. */
  get canceled(): boolean {
    return this.pipes.get(4)!.stream.destroyed
  }

  /** Endpoints arrive before any byte is written to them, so the launcher holds no input. */
  attach(
    pid: number,
    endpoints: ReadonlyMap<number, Readable | Writable | null | undefined>
  ): void {
    if (this.settled) {
      return
    }
    const missing = PIPE_DIRECTIONS.some(([fd]) => !endpoints.get(fd))
    if (missing) {
      for (const endpoint of endpoints.values()) {
        endpoint?.destroy()
      }
      this.fail(new Error('Provider launch did not create its required pipes'))
      return
    }
    this.settled = true
    for (const [fd, pipe] of this.pipes) {
      pipe.attach(endpoints.get(fd)!)
    }
    this.pid = pid
    this.emit('spawn')
  }

  fail(error: Error): void {
    if (this.settled) {
      return
    }
    this.settled = true
    for (const pipe of this.pipes.values()) {
      pipe.fail()
    }
    this.emit('error', error)
    this.emit('close', null, null)
  }

  private fromOwner(fd: number): Readable {
    const stream = this.pipes.get(fd)!.stream
    if (!(stream instanceof Readable)) {
      throw new TypeError(`Provider pipe ${fd} is not readable`)
    }
    return stream
  }
}
