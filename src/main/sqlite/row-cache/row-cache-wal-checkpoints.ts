import { spawnWorkerThread } from '../../worker-threads/worker-thread-spawn'
import { LazyWorkerThreadHost } from '../../worker-threads/lazy-worker-thread-host'
import type { WorkerThreadFactory } from '../../worker-threads/worker-thread-transport'

const IDLE_TEARDOWN_MS = 60_000
// A file that keeps failing goes back to checkpointing in its own commits rather than growing.
const MAX_CONSECUTIVE_FAILURES = 3

type CheckpointResult = { path: string; ok: boolean }

// Evaluated source: a passive checkpoint waits on no writer, and a removed cache is never recreated.
const checkpointWorkerSource = `
const { parentPort } = require('node:worker_threads');
const { existsSync } = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
parentPort.on('message', ({ path }) => {
  let ok = true;
  if (existsSync(path)) {
    let db;
    try {
      db = new DatabaseSync(path);
      db.exec('PRAGMA busy_timeout = 1000');
      db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();
    } catch {
      ok = false;
    } finally {
      try { db?.close(); } catch {}
    }
  }
  parentPort.postMessage({ path, ok });
});
`

function defaultFactory(): ReturnType<WorkerThreadFactory> {
  return spawnWorkerThread(checkpointWorkerSource, { name: 'orca-row-cache-checkpoint', eval: true })
}

/**
 * Row caches commit on main; an auto-checkpointing commit fsyncs the database file and blocked
 * main for 346 ms on a busy disk. While this worker runs, those connections never auto-checkpoint
 * and the worker folds each cache's WAL after its commits. Any worker failure hands checkpoints
 * back to the connections at once.
 */
export class RowCacheWalCheckpoints {
  private readonly host: LazyWorkerThreadHost<CheckpointResult>
  private readonly restores = new Map<string, () => void>()
  private readonly inFlight = new Set<string>()
  private readonly again = new Set<string>()
  private readonly failures = new Map<string, number>()
  private failed = false

  constructor(factory: WorkerThreadFactory = defaultFactory) {
    this.host = new LazyWorkerThreadHost<CheckpointResult>({
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
  }

  /** True when the connection should stop auto-checkpointing; `restore` turns it back on. */
  attach(path: string, restore: () => void): boolean {
    if (this.failed) {
      return false
    }
    this.restores.set(path, restore)
    return true
  }

  detach(path: string): void {
    this.restores.delete(path)
    this.again.delete(path)
  }

  /** After a commit; one checkpoint per file at a time, and a commit during it queues one more. */
  request(path: string): void {
    if (this.failed || !this.restores.has(path)) {
      return
    }
    if (this.inFlight.has(path)) {
      this.again.add(path)
      return
    }
    const worker = this.host.ensure()
    if (!worker) {
      this.fail()
      return
    }
    this.host.clearIdleTimer()
    this.inFlight.add(path)
    try {
      worker.postMessage({ path })
    } catch {
      this.fail()
    }
  }

  private settle({ path, ok }: CheckpointResult): void {
    this.inFlight.delete(path)
    const failures = ok ? 0 : (this.failures.get(path) ?? 0) + 1
    if (failures >= MAX_CONSECUTIVE_FAILURES) {
      this.failures.delete(path)
      this.restores.get(path)?.()
      this.detach(path)
    } else if (failures > 0) {
      this.failures.set(path, failures)
    } else {
      this.failures.delete(path)
    }
    if (this.again.delete(path)) {
      this.request(path)
    }
    if (this.inFlight.size === 0) {
      this.host.scheduleIdleTeardown()
    }
  }

  private fail(): void {
    if (this.failed) {
      return
    }
    this.failed = true
    this.host.destroy()
    const restores = [...this.restores.values()]
    this.restores.clear()
    this.inFlight.clear()
    this.again.clear()
    for (const restore of restores) {
      restore()
    }
  }
}

export const rowCacheWalCheckpoints = new RowCacheWalCheckpoints()
