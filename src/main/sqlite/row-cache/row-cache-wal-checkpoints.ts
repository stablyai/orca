import { spawnWorkerThread } from '../../worker-threads/worker-thread-spawn'
import { LazyWorkerThreadHost } from '../../worker-threads/lazy-worker-thread-host'
import type { WorkerThreadFactory } from '../../worker-threads/worker-thread-transport'

const IDLE_TEARDOWN_MS = 60_000
// A worker that never answers hands checkpoints back rather than letting WALs grow.
const RESPONSE_DEADLINE_MS = 30_000
// A file whose checkpoints keep failing or stopping short goes back to checkpointing itself.
const MAX_CONSECUTIVE_FAILURES = 3
// SQLite's own auto-checkpoint size: each full checkpoint lets the next commit restart the WAL,
// and a restart syncs its header on main, so checkpointing more often would add main-thread syncs.
const CHECKPOINT_FRAMES = 1000

type CheckpointResult = { id: number; ok: boolean; unsupported?: boolean }

/**
 * Evaluated source. `mode=rw` never creates a removed cache; a PASSIVE checkpoint never waits on
 * the writer, and counts as done only when it folded every frame. The handle lives for one
 * request, so a closed cache's file is free again within milliseconds. Older SQLite runs an unknown
 * wal_checkpoint mode as PASSIVE, which would checkpoint after every commit, so before 3.51 (NOOP)
 * the worker reports itself unsupported and every connection checkpoints itself again.
 */
export const rowCacheCheckpointWorkerSource = `
const { parentPort } = require('node:worker_threads');
const { pathToFileURL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');
const probe = new DatabaseSync(':memory:');
const [major, minor] = probe.prepare('SELECT sqlite_version() AS v').get().v.split('.').map(Number);
probe.close();
const supported = major > 3 || (major === 3 && minor >= 51);
parentPort.on('message', ({ id, path }) => {
  if (!supported) {
    parentPort.postMessage({ id, ok: false, unsupported: true });
    return;
  }
  let ok = false;
  let db;
  try {
    const url = pathToFileURL(path);
    url.searchParams.set('mode', 'rw');
    db = new DatabaseSync(url);
    db.exec('PRAGMA busy_timeout = 1000');
    const pending = db.prepare('PRAGMA wal_checkpoint(NOOP)').get();
    if (pending.log - pending.checkpointed < ${CHECKPOINT_FRAMES}) {
      ok = true;
    } else {
      const state = db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();
      ok = state.busy === 0 && state.log === state.checkpointed;
    }
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
 * 346 ms. While this worker is healthy, it checkpoints after registered connections' commits, and
 * they auto-checkpoint only at 10,000 pages, a backstop for commits that keep landing during
 * checkpoints. Any worker failure hands checkpoints back at once.
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

  private settle({ id, ok, unsupported }: CheckpointResult): void {
    if (unsupported) {
      this.fail()
      return
    }
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
