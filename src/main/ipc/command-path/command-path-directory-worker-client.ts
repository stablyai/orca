import type { Worker } from 'node:worker_threads'
import type { InstallDirectoryListing } from '../../../shared/shell/command-resolution/inventory-fs-probes'
import { readInstallSubdirectories } from './command-path-directory'
import { spawnWorkerThread } from '../../worker-threads/worker-thread-spawn'
import { LazyWorkerThreadHost } from '../../worker-threads/lazy-worker-thread-host'
import type { WorkerThreadFactory } from '../../worker-threads/worker-thread-transport'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../../worker-threads/worker-thread-entry-path'
import type {
  DetectionDirectoryListing,
  DetectionDirectoryRequest,
  DetectionDirectoryResponse,
  DirectoryWorkerListing
} from './command-path-directory-worker-protocol'

const IDLE_TEARDOWN_MS = 60_000
const REQUEST_TIMEOUT_MS = 10_000
const MAX_PENDING_LISTINGS = 16
let workerEntryMissing = false

function createWorker(): Worker {
  const workerPath = resolveWorkerThreadEntryPath(
    currentWorkerEntryLayout(__dirname),
    'command-path-directory-worker-entry.js'
  )
  return spawnWorkerThread(workerPath, { name: 'orca-command-path-directory' })
}

/** fs.Dir can synchronously lstat unknown entry types, even during async iteration. */
export class DetectionDirectoryWorkerClient {
  private readonly host: LazyWorkerThreadHost<DetectionDirectoryResponse>
  private readonly pending = new Map<
    number,
    { resolve: (listing: DirectoryWorkerListing) => void; timer?: NodeJS.Timeout }
  >()
  private nextId = 1

  constructor(
    private readonly workerFactory: WorkerThreadFactory = createWorker,
    private readonly mode: DetectionDirectoryRequest['mode'] = 'path'
  ) {
    this.host = new LazyWorkerThreadHost({
      factory: workerFactory,
      idleTeardownMs: IDLE_TEARDOWN_MS,
      awaitRetirement: true,
      strictRetirement: this.mode !== 'path',
      isIdle: () => this.pending.size === 0,
      onMessage: (response) => {
        const call = this.pending.get(response.id)
        if (!call) {
          return
        }
        clearTimeout(call.timer)
        this.pending.delete(response.id)
        call.resolve(response.listing)
        if (this.pending.size === 0) {
          this.host.current?.unref()
          this.host.scheduleIdleTeardown()
        }
      },
      onError: (error) => {
        if (
          workerFactory === createWorker &&
          'code' in error &&
          (error.code === 'MODULE_NOT_FOUND' || error.code === 'ERR_MODULE_NOT_FOUND')
        ) {
          workerEntryMissing = true
        }
        this.dispose()
      },
      onExit: () => this.dispose(),
      onUnavailable: () => {}
    })
  }

  read(dir: string): Promise<DirectoryWorkerListing> {
    if (
      (workerEntryMissing && this.workerFactory === createWorker) ||
      (this.mode === 'path' && this.pending.size >= MAX_PENDING_LISTINGS)
    ) {
      return Promise.resolve(null)
    }
    const worker = this.host.ensure()
    if (!worker) {
      return Promise.resolve(null)
    }
    this.host.clearIdleTimer()
    const id = this.nextId++
    return new Promise((resolve) => {
      const timer =
        this.mode === 'install' ? undefined : setTimeout(() => this.dispose(), REQUEST_TIMEOUT_MS)
      if (this.mode !== 'path' && 'ref' in worker && typeof worker.ref === 'function') {
        worker.ref()
      }
      this.pending.set(id, { resolve, timer })
      const request: DetectionDirectoryRequest = { id, dir, mode: this.mode }
      try {
        worker.postMessage(request)
      } catch {
        this.dispose()
      }
    })
  }

  dispose(): void {
    // Keep ownership through retirement while releasing waiters.
    this.host.destroy()
    for (const { resolve, timer } of this.pending.values()) {
      clearTimeout(timer)
      resolve(null)
    }
    this.pending.clear()
  }
}

let client: DetectionDirectoryWorkerClient | undefined
let inventoryClient: DetectionDirectoryWorkerClient | undefined
let installClient: DetectionDirectoryWorkerClient | undefined
let cliInventory = false

export function enableCliInventoryDirectoryReads(): void {
  cliInventory = true
}

export async function readInstallDirectoriesViaWorker(
  dir: string
): Promise<InstallDirectoryListing | null> {
  if (cliInventory) {
    return readInstallSubdirectories(dir, 'cli')
  }
  installClient ??= new DetectionDirectoryWorkerClient(createWorker, 'install')
  const listing = await installClient.read(dir)
  return listing && typeof listing === 'object' && 'names' in listing ? listing : null
}

export async function readDetectionDirectoryViaWorker(
  dir: string,
  inventory = false
): Promise<DetectionDirectoryListing> {
  const workerClient = inventory
    ? (inventoryClient ??= new DetectionDirectoryWorkerClient(createWorker, 'inventory'))
    : (client ??= new DetectionDirectoryWorkerClient())
  const listing = await workerClient.read(dir)
  return listing instanceof Map ? listing : null
}
