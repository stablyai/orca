import { spawnWorkerThread } from '../../worker-threads/worker-thread-spawn'
import { LazyWorkerThreadHost } from '../../worker-threads/lazy-worker-thread-host'
import type { WorkerThreadFactory } from '../../worker-threads/worker-thread-transport'

const IDLE_TEARDOWN_MS = 60_000
// A worker that never answers hands checkpoints back rather than letting WALs grow.
const RESPONSE_DEADLINE_MS = 30_000
// A file whose checkpoints keep failing or stopping short goes back to checkpointing itself.
const MAX_CONSECUTIVE_FAILURES = 3

type CheckpointResult = { id: number; ok: boolean }

/**
 * Evaluated source. `mode=rw` never creates a removed cache; a PASSIVE checkpoint never waits on
 * the writer, and counts as done only when it folded every frame. The handle lives for one
 * checkpoint, so a closed cache's file is free again within milliseconds.
 */
export const rowCacheCheckpointWorkerSource = `
const { parentPort } = require('node:worker_threads');
const { pathToFileURL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');
parentPort.on('message', ({ id, path }) => {
  let ok = false;
  let db;
  try {
    const url = pathToFileURL(path);
    url.searchParams.set('mode', 'rw');
    db = new DatabaseSync(url);
    db.exec('PRAGMA busy_timeout = 1000');
    const state = db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();
    ok = state.busy === 0 && state.log === state.checkpointed;
  } catch {
    ok = false;
  } finally {
    try { db?.close(); } catch {}
  }
  parentPort.postMessage({ id, ok });
});
`

export function spawnRowCacheCheckpointWorker(): ReturnType<WorkerThreadFactory> {
  return spawnWorkerThread(rowCacheCheckpointWorkerSource, {
    name: 'orca-row-cache-checkpoint',
    eval: true
  })
}

type Registration = { path: string; restore: () => void; failures: number }

/**
 * Row caches commit on main, and a commit that crosses the WAL auto-checkpoint threshold also
 * checkpoints and fsyncs inside the commit; under disk load one agent-status save held main for
 * 346 ms. While this worker is healthy, registered connections never auto-checkpoint and the
 * worker checkpoints after their commits. Any worker failure hands checkpoints back at once.
 */
export class RowCacheWalCheckpoints {
  private readonly host: LazyWorkerThreadHost<CheckpointResult> | null
  private readonly registrations = new Map<number, Registration>()
  private readonly inFlight = new Map<number, ReturnType<typeof setTimeout>>()
  private readonly again = new Set<number>()
  private nextId = 1
  private failed = false

  /** A null factory turns the service off: connections keep checkpointing themselves. */
  constructor(factory: WorkerThreadFactory | null) {
    this.host = factory
      ? new LazyWorkerThreadHost<CheckpointResult>({
          factory,
          idleTeardownMs: IDLE_TEARDOWN_MS,
          onMessage: (result) => this.settle(result),
          onError: () => this.fail(),
          onExit: () => this.fail(),
          isIdle: () => this.inFlight.size === 0,
          onUnavailable: (error) =>
            console.warn(
              `[row-cache] checkpoint worker unavailable; commits checkpoint on main. ${error instanceof Error ? error.message : String(error)}`
            )
        })
      : null
  }

  /** A registration id when the connection should stop auto-checkpointing; `restore` turns it back on. */
  attach(path: string, restore: () => void): number | null {
    if (!this.host || this.failed) {
      return null
    }
    const id = this.nextId++
    this.registrations.set(id, { path, restore, failures: 0 })
    return id
  }

  /** Drops queued work; a checkpoint already running finishes on its own short-lived handle. */
  detach(id: number): void {
    this.registrations.delete(id)
    this.again.delete(id)
  }

  /** After a commit; one checkpoint per connection at a time, and a commit during it queues one more. */
  request(id: number): void {
    const registration = this.registrations.get(id)
    if (!registration || !this.host || this.failed) {
      return
    }
    if (this.inFlight.has(id)) {
      this.again.add(id)
      return
    }
    const worker = this.host.ensure()
    if (!worker) {
      this.fail()
      return
    }
    this.host.clearIdleTimer()
    const deadline = setTimeout(() => this.fail(), RESPONSE_DEADLINE_MS)
    deadline.unref?.()
    this.inFlight.set(id, deadline)
    try {
      worker.postMessage({ id, path: registration.path })
    } catch {
      this.fail()
    }
  }

  private settle({ id, ok }: CheckpointResult): void {
    clearTimeout(this.inFlight.get(id))
    this.inFlight.delete(id)
    const registration = this.registrations.get(id)
    if (registration) {
      registration.failures = ok ? 0 : registration.failures + 1
      if (registration.failures >= MAX_CONSECUTIVE_FAILURES) {
        this.detach(id)
        registration.restore()
      } else if (this.again.delete(id)) {
        this.request(id)
      }
    }
    if (this.inFlight.size === 0) {
      this.host?.scheduleIdleTeardown()
    }
  }

  private fail(): void {
    if (this.failed) {
      return
    }
    this.failed = true
    this.host?.destroy()
    for (const deadline of this.inFlight.values()) {
      clearTimeout(deadline)
    }
    this.inFlight.clear()
    this.again.clear()
    const registrations = [...this.registrations.values()]
    this.registrations.clear()
    for (const registration of registrations) {
      registration.restore()
    }
  }
}

// Unit tests remove their temporary databases at once; they inject a worker when they test this.
export const rowCacheWalCheckpoints = new RowCacheWalCheckpoints(
  process.env.VITEST ? null : spawnRowCacheCheckpointWorker
)
