import { existsSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import { LazyWorkerThreadHost, type WorkerThreadFactory } from '../lazy-worker-thread-host'
import { currentWorkerEntryLayout, resolveWorkerThreadEntryPath } from '../worker-thread-entry-path'
import type {
  DetectionDirectoryRequest,
  DetectionDirectoryResponse
} from './command-path-directory-worker-protocol'

const IDLE_TEARDOWN_MS = 60_000
const REQUEST_TIMEOUT_MS = 10_000
const MAX_PENDING_LISTINGS = 16

function createWorker(): Worker {
  const workerPath = resolveWorkerThreadEntryPath(
    currentWorkerEntryLayout(__dirname),
    'command-path-directory-worker-entry.js'
  )
  if (!existsSync(workerPath)) {
    throw new Error(`Detection directory worker entry not found: ${workerPath}`)
  }
  return new Worker(workerPath)
}

/** fs.Dir can synchronously lstat unknown entry types, even during async iteration. */
export class DetectionDirectoryWorkerClient {
  private readonly host: LazyWorkerThreadHost<DetectionDirectoryResponse>
  private readonly pending = new Map<
    number,
    { resolve: (names: Map<string, string> | null) => void; timer: NodeJS.Timeout }
  >()
  private nextId = 1

  constructor(workerFactory: WorkerThreadFactory = createWorker) {
    this.host = new LazyWorkerThreadHost({
      factory: workerFactory,
      idleTeardownMs: IDLE_TEARDOWN_MS,
      awaitRetirement: true,
      isIdle: () => this.pending.size === 0,
      onMessage: (response) => {
        const call = this.pending.get(response.id)
        if (!call) {
          return
        }
        clearTimeout(call.timer)
        this.pending.delete(response.id)
        call.resolve(response.names)
        if (this.pending.size === 0) {
          this.host.scheduleIdleTeardown()
        }
      },
      onError: () => this.dispose(),
      onExit: () => this.dispose(),
      onUnavailable: () => {}
    })
  }

  read(dir: string): Promise<Map<string, string> | null> {
    if (this.pending.size >= MAX_PENDING_LISTINGS) {
      return Promise.resolve(null)
    }
    const worker = this.host.ensure()
    if (!worker) {
      return Promise.resolve(null)
    }
    this.host.clearIdleTimer()
    const id = this.nextId++
    return new Promise((resolve) => {
      // Keep plain-Node CLI invocations alive until their listings settle.
      const timer = setTimeout(() => this.dispose(), REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, timer })
      const request: DetectionDirectoryRequest = { id, dir }
      try {
        worker.postMessage(request)
      } catch {
        this.dispose()
      }
    })
  }

  dispose(): void {
    this.host.destroy()
    for (const { resolve, timer } of this.pending.values()) {
      clearTimeout(timer)
      // Failure falls back to async candidate probes, never an inline listing.
      resolve(null)
    }
    this.pending.clear()
  }
}

let client: DetectionDirectoryWorkerClient | undefined

export function readDetectionDirectoryViaWorker(dir: string): Promise<Map<string, string> | null> {
  client ??= new DetectionDirectoryWorkerClient()
  return client.read(dir)
}
