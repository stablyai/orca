import { Worker } from 'node:worker_threads'

/** Owns one writer thread's lifetime so recovery can prove it exited before replacing it. */
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
    this.worker = new Worker(workerPath, { workerData, execArgv: [] })
    this.worker.on('message', handlers.message)
    this.worker.on('error', handlers.error)
    this.worker.once('exit', (code) => {
      this.exitedFlag = true
      this.exit.resolve()
      handlers.exit(code)
    })
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
