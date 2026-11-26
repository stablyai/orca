import { existsSync } from 'node:fs'
import type { Worker } from 'node:worker_threads'
import { spawnWorkerThread } from '../../worker-threads/worker-thread-spawn'
import { LazyWorkerThreadHost } from '../../worker-threads/lazy-worker-thread-host'
import type { WorkerThreadFactory } from '../../worker-threads/worker-thread-transport'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../../worker-threads/worker-thread-entry-path'
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
  return spawnWorkerThread(workerPath, { name: 'orca-command-path-directory' })
}

/** fs.Dir can synchronously lstat unknown entry types, even during async iteration. */
export class DetectionDirectoryWorkerClient {
  private readonly host: LazyWorkerThreadHost<DetectionDirectoryResponse>
  private readonly pending = new Map<
    number,
    { resolve: (names: Map<string, string> | null) => void; timer?: NodeJS.Timeout }
  >()
  private nextId = 1

  constructor(
    workerFactory: WorkerThreadFactory = createWorker,
    private readonly retainPending = false
  ) {
    this.host = new LazyWorkerThreadHost({
      factory: workerFactory,
      idleTeardownMs: IDLE_TEARDOWN_MS,
      awaitRetirement: true,
      strictRetirement: this.retainPending,
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
          this.host.current?.unref()
          this.host.scheduleIdleTeardown()
        }
      },
      onError: () => this.dispose(),
      onExit: () => this.dispose(),
      onUnavailable: () => {}
    })
  }

  read(dir: string): Promise<Map<string, string> | null> {
    if (!this.retainPending && this.pending.size >= MAX_PENDING_LISTINGS) {
      return Promise.resolve(null)
    }
    const worker = this.host.ensure()
    if (!worker) {
      return Promise.resolve(null)
    }
    this.host.clearIdleTimer()
    const id = this.nextId++
    return new Promise((resolve) => {
      // Inventory owns the deadline and keeps its worker request until the native read settles.
      const timer = this.retainPending
        ? undefined
        : setTimeout(() => this.dispose(), REQUEST_TIMEOUT_MS)
      if (this.retainPending && 'ref' in worker && typeof worker.ref === 'function') {
        worker.ref()
      }
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
    const pending = [...this.pending.values()]
    this.pending.clear()
    const settle = (): void => {
      for (const { resolve, timer } of pending) {
        clearTimeout(timer)
        resolve(null)
      }
    }
    if (this.retainPending) {
      void this.host.retired().then(settle, () => {})
      return
    }
    settle()
  }
}

let client: DetectionDirectoryWorkerClient | undefined
let inventoryClient: DetectionDirectoryWorkerClient | undefined

export function readDetectionDirectoryViaWorker(
  dir: string,
  retainPending = false
): Promise<Map<string, string> | null> {
  if (retainPending) {
    inventoryClient ??= new DetectionDirectoryWorkerClient(createWorker, true)
    return inventoryClient.read(dir)
  }
  client ??= new DetectionDirectoryWorkerClient()
  return client.read(dir)
}
