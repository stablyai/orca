import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { WorkerRequestTransport, WorkerThreadFactory } from '../lazy-worker-thread-host'
import { WorkerThreadRequestQueue } from '../worker-thread-request-queue'
import type { CursorDesktopProfileReadResult } from './cursor-desktop-state-db'

export type CursorDesktopProfileRequest = { id: number; dbPath: string }
export type CursorDesktopProfileResponse = {
  id: number
  result: CursorDesktopProfileReadResult
}

const ENTRY = 'cursor-desktop-profile-worker-entry.js'
const READ_ERROR = 'Unable to read the Cursor desktop login'

export function resolveCursorDesktopProfileWorkerPath(runtimeDir = __dirname): string {
  for (const candidate of [join(runtimeDir, ENTRY), join(runtimeDir, '..', ENTRY)]) {
    if (existsSync(candidate)) {
      return candidate
    }
  }
  throw new Error('Cursor desktop login worker is unavailable')
}

export class CursorDesktopProfileWorker {
  private readonly queue: WorkerThreadRequestQueue<
    CursorDesktopProfileRequest,
    CursorDesktopProfileResponse
  >
  private readonly inflight = new Map<string, Promise<CursorDesktopProfileReadResult>>()
  private retiring = false

  constructor(
    factory: WorkerThreadFactory,
    private readonly timeoutMs = 10_000
  ) {
    this.queue = new WorkerThreadRequestQueue({
      factory: () => this.createWorker(factory),
      idleTeardownMs: 30_000,
      maxConsecutiveDeaths: 2,
      queueCap: { maxQueuedCalls: 8, describeFull: () => READ_ERROR },
      createUnavailableError: () => new Error(READ_ERROR),
      describeTimeout: () => READ_ERROR,
      describeExit: () => READ_ERROR,
      describeCrashLoop: () => READ_ERROR,
      onUnavailable: () => undefined
    })
  }

  read(dbPath: string): Promise<CursorDesktopProfileReadResult> {
    const pending = this.inflight.get(dbPath)
    if (pending) {
      return pending
    }
    const read = this.queue
      .dispatch((id) => ({ id, dbPath }), this.timeoutMs)
      .then(({ result }) => result)
      .catch((): CursorDesktopProfileReadResult => ({
        status: 'error',
        error: READ_ERROR
      }))
      .finally(() => this.inflight.delete(dbPath))
    this.inflight.set(dbPath, read)
    return read
  }

  dispose(): void {
    this.queue.dispose()
    this.inflight.clear()
  }

  private createWorker(factory: WorkerThreadFactory): WorkerRequestTransport {
    if (this.retiring) {
      throw new Error(READ_ERROR)
    }
    const worker = factory()
    return {
      on: (...args) => worker.on(...args),
      off: (...args) => worker.off(...args),
      removeAllListeners: () => worker.removeAllListeners(),
      unref: () => worker.unref(),
      postMessage: (...args) => worker.postMessage(...args),
      terminate: () => {
        // Native SQLite work can delay termination; never overlap retired workers.
        this.retiring = true
        return worker.terminate().then((code) => {
          this.retiring = false
          return code
        })
      }
    }
  }
}

let client: CursorDesktopProfileWorker | undefined

export function readCursorDesktopProfileViaWorker(
  dbPath: string
): Promise<CursorDesktopProfileReadResult> {
  // WAL recovery must never fall back to the Electron main thread.
  client ??= new CursorDesktopProfileWorker(
    () => new Worker(resolveCursorDesktopProfileWorkerPath())
  )
  return client.read(dbPath)
}
