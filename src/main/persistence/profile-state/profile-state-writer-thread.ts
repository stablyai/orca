import type { Worker } from 'node:worker_threads'
import { spawnWorkerThread } from '../../worker-threads/worker-thread-spawn'
import { takePrewarmedProfileStateWriterThread } from './profile-state-writer-prewarm'

/** Recovery must observe thread exit before replacing its owner. */
export class ProfileStateWriterThread {
  private readonly worker: Worker
  private readonly exit = Promise.withResolvers<void>()
  private exitedFlag = false

  constructor(
    workerPath: string,
    workerData: unknown,
    handlers: {
      message: (value: unknown) => void
      error: (cause: Error) => void
      exit: (code: number) => void
    }
  ) {
    const prewarmed = takePrewarmedProfileStateWriterThread(workerPath)
    this.worker = prewarmed ?? spawnWorkerThread(workerPath, { workerData, execArgv: [] })
    this.worker.on('message', handlers.message)
    this.worker.on('error', handlers.error)
    this.worker.once('exit', (code) => {
      this.exitedFlag = true
      this.exit.resolve()
      handlers.exit(code)
    })
    if (prewarmed) {
      // A prewarmed thread waits for its initialization as its first message.
      this.worker.postMessage(workerData)
    }
  }

  get exited(): boolean {
    return this.exitedFlag
  }

  get exitPromise(): Promise<void> {
    return this.exit.promise
  }

  post(message: unknown): void {
    this.worker.postMessage(message)
  }

  terminate(): void {
    if (!this.exitedFlag) {
      void this.worker.terminate().catch(() => {})
    }
  }
}
