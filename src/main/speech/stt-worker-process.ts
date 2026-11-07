import { EventEmitter } from 'node:events'
import type { WorkerRequestTransport } from '../worker-threads/worker-thread-transport'

export const STT_WORKER_EXITED_ERROR = 'The speech engine stopped unexpectedly. Try again.'
export const STT_WORKER_HUNG_ERROR = 'The speech engine stopped responding. Try again.'

export type SttWorkerProcess = WorkerRequestTransport
export type SpawnSttWorkerProcess = () => SttWorkerProcess

/** Session code drops its listeners with removeAllListeners; this keeps the child's own intact. */
export class SttWorkerChildProcess extends EventEmitter implements SttWorkerProcess {
  private exited = false
  private readonly exit = Promise.withResolvers<number>()

  constructor(
    private readonly child: {
      send(message: object): void
      kill(): void
    }
  ) {
    super()
  }

  postMessage(message: object): void {
    if (!this.exited) {
      this.child.send(message)
    }
  }

  /** Kills even a decode stuck in native code; resolves once the process is gone. */
  terminate(): Promise<number> {
    if (!this.exited) {
      this.child.kill()
    }
    return this.exit.promise
  }

  unref(): void {}

  receiveMessage(message: unknown): void {
    this.emit('message', message)
  }

  receiveError(error: Error): void {
    // An 'error' with no listener would throw in main after session code detached.
    if (this.listenerCount('error') > 0) {
      this.emit('error', error)
    }
  }

  receiveExit(code: number | null): void {
    if (this.exited) {
      return
    }
    this.exited = true
    this.emit('exit', code ?? 1)
    this.exit.resolve(code ?? 1)
  }
}

export function logSttWorkerStderr(stderr: NodeJS.ReadableStream | null | undefined): void {
  stderr?.on('data', (chunk: Buffer) => {
    console.error('[speech-worker]', String(chunk).trimEnd())
  })
}
