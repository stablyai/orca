import { unrefTimer } from '../../../shared/timers/unref-timer'
import { spawnWorkerThread } from '../../worker-threads/worker-thread-spawn'
import { LazyWorkerThreadHost } from '../../worker-threads/lazy-worker-thread-host'
import type { WorkerThreadFactory } from '../../worker-threads/worker-thread-transport'

const IDLE_TEARDOWN_MS = 60_000
// A worker that never answers hands checkpoints back rather than letting WALs grow.
const RESPONSE_DEADLINE_MS = 30_000
// A file whose checkpoints keep failing goes back to checkpointing itself.
const MAX_CONSECUTIVE_FAILURES = 3
// SQLite's own auto-checkpoint size: each full checkpoint lets the next commit restart the WAL,
// and a restart syncs its header on main, so checkpointing more often would add main-thread syncs.
const CHECKPOINT_FRAMES = 1000
// Commits that landed during a checkpoint leave a tail; the WAL restarts only once that drains.
const CATCH_UP_IDLE_MS = 100

type CheckpointResult = { id: number; ok: boolean; catchUp?: boolean; unsupported?: boolean }

/**
 * Evaluated source. `mode=rw` never creates a removed cache; a PASSIVE checkpoint never waits on
 * the writer. `catchUp` is set only when a checkpoint ran: whether frames remain for one more once
 * writes pause (a catch-up asks again only while it makes progress; a reader can pin the tail).
 * The handle lives for one request, so a closed cache's file is free again within milliseconds. Older SQLite runs an unknown
 * wal_checkpoint mode as PASSIVE, which would checkpoint after every commit, so before 3.51 (NOOP)
 * the worker reports itself unsupported and every connection checkpoints itself again.
 */
export const rowCacheCheckpointWorkerSource = `
const { parentPort } = require('node:worker_threads');
const { pathToFileURL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');
const probe = new DatabaseSync(':memory:');
const [major, minor, patch] = probe.prepare('SELECT sqlite_version() AS v').get().v.split('.').map(Number);
probe.close();
// 3.51.0-3.51.2 can corrupt a WAL reset that overlaps a checkpoint, exactly what this worker does.
const supported = major > 3 || (major === 3 && (minor > 51 || (minor === 51 && patch >= 3)));
parentPort.on('message', ({ id, path, force }) => {
  if (!supported) {
    parentPort.postMessage({ id, ok: false, unsupported: true });
    return;
  }
  let ok = false;
  let catchUp;
  let db;
  try {
    const url = pathToFileURL(path);
    url.searchParams.set('mode', 'rw');
    db = new DatabaseSync(url);
    db.exec('PRAGMA busy_timeout = 1000');
    const frames = db.prepare('PRAGMA wal_checkpoint(NOOP)');
    const before = frames.get();
    const pending = before.log - before.checkpointed;
    if (pending >= ${CHECKPOINT_FRAMES} || (force && pending > 0)) {
      const state = db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();
      const after = frames.get();
      // A commit already restarted the WAL (fewer frames or less backfill since): nothing is owed.
      const restarted = after.log < state.log || after.checkpointed < state.checkpointed;
      const progressed = state.checkpointed > before.checkpointed;
      catchUp = !restarted && after.log > after.checkpointed && (!force || progressed);
    } else if (force) {
      catchUp = false;
    }
    ok = true;
  } catch {
    ok = false;
  } finally {
    try { db?.close(); } catch {}
  }
  parentPort.postMessage({ id, ok, catchUp });
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
  private readonly inFlight = new Map<
    number,
    { deadline: ReturnType<typeof setTimeout>; path: string }
  >()
  private readonly again = new Set<number>()
  // One checkpoint is posted at a time, so a hung one never strands requests the worker never began.
  private readonly waiting = new Map<number, boolean>()
  // Checkpoints a failed worker may still be finishing; removal waits for that worker's exit.
  private retiringPaths: { path: string }[] = []
  // Files whose checkpoints kept failing stay on SQLite's own checkpointing, across reopens.
  private readonly failedPaths = new Set<string>()
  private readonly catchUpOwed = new Set<number>()
  private readonly catchUps = new Map<number, ReturnType<typeof setTimeout>>()
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
          onExit: () => this.fail({ exited: true }),
          isIdle: () => this.inFlight.size === 0,
          onUnavailable: (error) =>
            console.warn(
              `[row-cache] checkpoint worker unavailable; commits checkpoint on main. ${error instanceof Error ? error.message : String(error)}`
            )
        })
      : null
  }

  /** A registration id when the connection should stop auto-checkpointing; `restore` turns it back on. */
  /** Whether a connection opening `path` now should leave its checkpoints to the worker. */
  available(path: string): boolean {
    return this.host !== null && !this.failed && !this.failedPaths.has(path)
  }

  attach(path: string, restore: () => void): number | null {
    if (!this.available(path)) {
      return null
    }
    const id = this.nextId++
    this.registrations.set(id, { path, restore, failures: 0 })
    return id
  }

  /**
   * Every removal of a row-cache file calls this first: a running checkpoint's closing handle can
   * unlink a recreated file's WAL, whichever connection or instance asked for the checkpoint.
   * Throws a busy error, so callers retry as they do for any locked database.
   */
  assertRemovable(path: string): void {
    for (const checkpoint of [...this.inFlight.values(), ...this.retiringPaths]) {
      if (checkpoint.path === path) {
        throw new Error('SQLITE_BUSY: row cache checkpoint still running')
      }
    }
  }

  /** Drops queued work; a checkpoint already running finishes on its own short-lived handle. */
  detach(id: number | null): void {
    if (id === null) {
      return
    }
    this.registrations.delete(id)
    this.again.delete(id)
    this.waiting.delete(id)
    this.catchUpOwed.delete(id)
    this.cancelCatchUp(id)
  }

  /** After a commit; one checkpoint per connection at a time, and a commit during it queues one more. */
  request(id: number): void {
    this.cancelCatchUp(id)
    this.send(id, false)
  }

  private send(id: number, force: boolean): void {
    const registration = this.registrations.get(id)
    if (!registration || !this.host || this.failed) {
      return
    }
    if (this.inFlight.has(id)) {
      this.again.add(id)
      return
    }
    if (this.inFlight.size > 0) {
      this.waiting.set(id, force || (this.waiting.get(id) ?? false))
      return
    }
    const worker = this.host.ensure()
    if (!worker) {
      this.fail()
      return
    }
    this.host.clearIdleTimer()
    const deadline = setTimeout(() => this.fail(), RESPONSE_DEADLINE_MS)
    unrefTimer(deadline)
    this.inFlight.set(id, { deadline, path: registration.path })
    try {
      worker.postMessage({ id, path: registration.path, force })
    } catch {
      this.fail()
    }
  }

  private cancelCatchUp(id: number): void {
    clearTimeout(this.catchUps.get(id))
    this.catchUps.delete(id)
  }

  private settle({ id, ok, catchUp, unsupported }: CheckpointResult): void {
    if (unsupported) {
      this.fail()
      return
    }
    clearTimeout(this.inFlight.get(id)?.deadline)
    this.inFlight.delete(id)
    const registration = this.registrations.get(id)
    if (registration) {
      registration.failures = ok ? 0 : registration.failures + 1
      if (catchUp) {
        this.catchUpOwed.add(id)
      } else if (catchUp === false) {
        this.catchUpOwed.delete(id)
      }
      if (registration.failures >= MAX_CONSECUTIVE_FAILURES) {
        this.failedPaths.add(registration.path)
        this.detach(id)
        registration.restore()
      } else if (this.again.delete(id)) {
        // Behind connections already waiting, so one busy cache can't starve the others.
        this.cancelCatchUp(id)
        this.waiting.set(id, this.waiting.get(id) ?? false)
      } else if (this.catchUpOwed.has(id)) {
        const timer = setTimeout(() => {
          this.catchUps.delete(id)
          this.send(id, true)
        }, CATCH_UP_IDLE_MS)
        unrefTimer(timer)
        this.catchUps.set(id, timer)
      }
    }
    const next = this.waiting.entries().next()
    if (!next.done) {
      this.waiting.delete(next.value[0])
      this.send(next.value[0], next.value[1])
    }
    if (this.inFlight.size === 0) {
      this.host?.scheduleIdleTeardown()
    }
  }

  private fail({ exited = false }: { exited?: boolean } = {}): void {
    if (this.failed) {
      return
    }
    this.failed = true
    const worker = exited ? null : (this.host?.current ?? null)
    this.host?.destroy()
    // A late startup error from the stripped worker must not surface as an uncaught exception.
    worker?.on('error', () => {})
    if (worker && this.inFlight.size > 0) {
      // Terminating doesn't stop a native checkpoint mid-call; its file stays unremovable until exit.
      const retiring = [...this.inFlight.values()].map(({ path }) => ({ path }))
      this.retiringPaths.push(...retiring)
      worker.on('exit', () => {
        this.retiringPaths = this.retiringPaths.filter((entry) => !retiring.includes(entry))
      })
    }
    for (const { deadline } of this.inFlight.values()) {
      clearTimeout(deadline)
    }
    this.inFlight.clear()
    this.again.clear()
    this.waiting.clear()
    this.catchUpOwed.clear()
    for (const timer of this.catchUps.values()) {
      clearTimeout(timer)
    }
    this.catchUps.clear()
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
