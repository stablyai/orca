import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import type { Worker } from 'node:worker_threads'
import { assertWslNotLatchedAbsent } from '@orca/process-host/wsl-not-installed-latch'
import { spawnWorkerThread } from '../worker-threads/worker-thread-spawn'
import { LazyWorkerThreadHost } from '../worker-threads/lazy-worker-thread-host'
import {
  endLostSpawns,
  type LostLauncher,
  type LostSpawn,
  SPAWN_KEY_ENV
} from './lost-spawn-processes'
import {
  PROCESS_LAUNCHER_LOST_CODE,
  WORKER_CHILD_ABANDONED_CODE,
  WorkerThreadChildProcess
} from './worker-thread-child-process-stand-in'
import type { WorkerThreadFactory } from '../worker-threads/worker-thread-transport'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../worker-threads/worker-thread-entry-path'
import type {
  WorkerThreadChildEvent,
  WorkerThreadChildRequest,
  WorkerThreadChildSpec
} from './worker-thread-child-process-protocol'

// #27362: Windows code-integrity hashing can block CreateProcessW for seconds on the calling loop. Spawn in a worker and fail closed if unavailable (#11161).

// Amortize worker startup across nearby probes.
export const IDLE_TEARDOWN_MS = 2 * 60_000

const WORKER_ENTRY_FILENAME = 'worker-thread-child-process-entry.js'

export {
  isAbandonedWorkerChildError,
  isWorkerChildStdinWriteError,
  PROCESS_LAUNCHER_LOST_CODE,
  WORKER_CHILD_ABANDONED_CODE,
  WorkerThreadChildProcess
} from './worker-thread-child-process-stand-in'

export class WorkerThreadChildProcessHost {
  private readonly host: LazyWorkerThreadHost<WorkerThreadChildEvent>
  private readonly children = new Map<number, WorkerThreadChildProcess>()
  private nextId = 1
  private workerAnswered = false
  private workerError: string | null = null
  // A worker that dies before answering anything is broken here (e.g. an unloadable chunk); stop offering it.
  private failedToStart = false
  // Settles true on the current worker's 'ready', false if it exits first.
  private ready: { promise: Promise<boolean>; settle: (ready: boolean) => void } | null = null

  /** Per in-flight child when the worker runs in another process (see endLostSpawns). */
  private readonly spawnKeys: Map<number, Omit<LostSpawn, 'pid'>> | null
  /** Where the current worker records its children's pids, from its 'ready'. */
  private spawnRecordDir: string | null = null
  /** The launcher process, whose not-yet-exec'd children show its command line. */
  private launcher: LostLauncher | null = null

  constructor(factory: WorkerThreadFactory, options: { tagSpawns?: boolean } = {}) {
    this.spawnKeys = options.tagSpawns ? new Map() : null
    this.host = new LazyWorkerThreadHost<WorkerThreadChildEvent>({
      factory,
      idleTeardownMs: IDLE_TEARDOWN_MS,
      onMessage: (event) => this.route(event),
      // A worker error can arrive ahead of messages it already posted; its exit comes after them, so decide there.
      onError: (error) => {
        this.workerError ??= error.message
      },
      onExit: (code) =>
        this.abandonAll(
          this.workerError === null
            ? `Child process worker exited with code ${code}`
            : `Child process worker failed: ${this.workerError}`
        ),
      isIdle: () => this.children.size === 0,
      onUnavailable: (error) =>
        console.warn(
          `[worker-thread-child-process] worker unavailable. ${error instanceof Error ? error.message : String(error)}`
        )
    })
  }

  /** Starts or reuses the worker; false while it cannot run, including during an idle retirement or after it failed to start. */
  available(): boolean {
    return this.ensureWorker()
  }

  /** True once the worker has loaded its entry; false if it can't start or dies first. */
  whenReady(): Promise<boolean> {
    return this.ensureWorker() && this.ready ? this.ready.promise : Promise.resolve(false)
  }

  /** Starts a cold worker without waiting; its first message is 'ready', so having answered means loaded. */
  isReady(): boolean {
    return this.ensureWorker() && this.workerAnswered
  }

  private ensureWorker(): boolean {
    // A worker that died before answering is not started again; direct spawns report it unavailable.
    if (this.failedToStart) {
      return false
    }
    if (!this.host.current) {
      // A fresh worker (first use or after idle teardown) has not proven it starts yet.
      this.workerAnswered = false
      this.workerError = null
      // An idle-retired worker's directory is empty; a lost one's went to endLost.
      if (this.spawnRecordDir) {
        void rm(this.spawnRecordDir, { recursive: true, force: true }).catch(() => undefined)
      }
      this.spawnRecordDir = null
      this.launcher = null
      this.ready?.settle(false)
      const ready = Promise.withResolvers<boolean>()
      this.ready = { promise: ready.promise, settle: ready.resolve }
    }
    return this.host.ensure() !== null
  }

  spawn(spec: WorkerThreadChildSpec): WorkerThreadChildProcess {
    const id = this.nextId++
    const child = new WorkerThreadChildProcess(id, (request) => this.post(request))
    if (this.ensureWorker()) {
      this.host.clearIdleTimer()
      this.children.set(id, child)
      const tagged = this.tagged(id, spec)
      if (this.post({ type: 'spawn', id, spec: tagged })) {
        return child
      }
      this.forget(id)
    }
    // Deferred like Node's own spawn errors, so the caller can attach listeners first.
    process.nextTick(() =>
      child.receive({
        type: 'spawn-error',
        id,
        error: { message: 'Child process worker is unavailable' }
      })
    )
    return child
  }

  private post(request: WorkerThreadChildRequest): boolean {
    const worker = this.host.current
    if (!worker || !this.children.has(request.id)) {
      return false
    }
    try {
      worker.postMessage(request)
      return true
    } catch {
      return false
    }
  }

  private route(event: WorkerThreadChildEvent): void {
    this.workerAnswered = true
    if (event.type === 'ready') {
      this.spawnRecordDir = event.spawnRecordDir ?? null
      const launcherPid = Number(/(\d+)-\d+$/.exec(event.spawnRecordDir ?? '')?.[1])
      this.launcher =
        event.launcherCmdline &&
        event.launcherStartTicks !== undefined &&
        event.launcherSid !== undefined &&
        Number.isInteger(launcherPid)
          ? {
              pid: launcherPid,
              cmdline: event.launcherCmdline,
              startTicks: event.launcherStartTicks,
              sid: event.launcherSid
            }
          : null
      this.ready?.settle(true)
      // Every launch that started this worker may have been cancelled while it loaded.
      if (this.children.size === 0) {
        this.host.scheduleIdleTeardown()
      }
      return
    }
    if (event.type === 'spawn' && event.recorded) {
      const lost = this.spawnKeys?.get(event.id)
      if (lost) {
        lost.recorded = true
      }
    }
    const child = this.children.get(event.id)
    if (!child) {
      return
    }
    child.receive(event)
    if (event.type === 'close' && event.retained) {
      this.post({ type: 'release', id: event.id })
    }
    if (
      event.type === 'spawn-error' ||
      (child.closed && (!child.ownedGroupStopping || child.ownedGroupTerminated))
    ) {
      this.forget(event.id)
    }
  }

  private tagged(id: number, spec: WorkerThreadChildSpec): WorkerThreadChildSpec {
    if (!this.spawnKeys) {
      return spec
    }
    const key = randomUUID()
    this.spawnKeys.set(id, {
      key,
      recorded: false,
      ownsGroup: spec.terminationBarrier === true,
      argv: [spec.program, ...(spec.args ?? [])]
    })
    return { ...spec, env: { ...(spec.env ?? process.env), [SPAWN_KEY_ENV]: key } }
  }

  private forget(id: number): void {
    this.children.delete(id)
    this.spawnKeys?.delete(id)
    if (this.children.size === 0) {
      this.host.scheduleIdleTeardown()
    }
  }

  /**
   * The worker ran in another process, so a pid or exit it posted may never have arrived. Its
   * children are ended first (see endLostSpawns); only then does each hear it was killed, so
   * admission, fences and output readers release as for any killed child. One that never started
   * fails to spawn instead.
   */
  private endLost(abandoned: readonly WorkerThreadChildProcess[], message: string): void {
    const recordDir = this.spawnRecordDir
    const launcher = this.launcher
    this.spawnRecordDir = null
    this.launcher = null
    const lost = new Map<WorkerThreadChildProcess, LostSpawn>()
    for (const child of abandoned) {
      const entry = this.spawnKeys?.get(child.id)
      this.spawnKeys?.delete(child.id)
      if (entry) {
        lost.set(child, { ...entry, ...(child.pid === undefined ? {} : { pid: child.pid }) })
      }
    }
    if (abandoned.length > 0) {
      console.warn(`[worker-thread-child-process] ${message}; ending ${abandoned.length} children.`)
    }
    const byKey = new Map([...lost].map(([child, spawn]) => [spawn.key, child]))
    // Never-tagged children (none in practice) have nothing to end.
    for (const child of abandoned.filter((candidate) => !lost.has(candidate))) {
      this.deliverLost(child, child.pid, child.pid !== undefined, message)
    }
    void endLostSpawns([...lost.values()], recordDir, launcher, (key, pid, started) => {
      const child = byKey.get(key)
      if (child) {
        this.deliverLost(child, child.pid ?? pid, started, message)
      }
    })
  }

  private deliverLost(
    child: WorkerThreadChildProcess,
    pid: number | undefined,
    started: boolean,
    message: string
  ): void {
    if (child.pid === undefined && !started) {
      const error = { message, code: PROCESS_LAUNCHER_LOST_CODE }
      child.receive({ type: 'spawn-error', id: child.id, error })
      return
    }
    if (child.pid === undefined && pid !== undefined) {
      child.receive({ type: 'spawn', id: child.id, pid })
    }
    child.receive({ type: 'group-terminated', id: child.id })
    if (!child.closed) {
      child.receive({ type: 'exit', id: child.id, code: null, signal: 'SIGKILL' })
      child.receive({ type: 'close', id: child.id, code: null, signal: 'SIGKILL' })
    }
  }

  // Worker death closes stdin for graceful stop but proves no child exit; omit close so drain windows/home locks still expire normally.
  private abandonAll(message: string): void {
    this.ready?.settle(false)
    if (!this.workerAnswered && !this.failedToStart) {
      this.failedToStart = true
      console.warn(`[worker-thread-child-process] worker died before answering. ${message}`)
    }
    this.workerAnswered = false
    this.workerError = null
    const abandoned = [...this.children.values()]
    this.children.clear()
    this.host.destroy()
    if (this.spawnKeys) {
      this.endLost(abandoned, message)
      return
    }
    // The worker posts a pid in the turn it creates the process and its messages arrive before 'exit',
    // so a child without one was never created (queued, or the worker was not ready): it fails to start.
    for (const child of abandoned) {
      child.receive({
        type: child.pid === undefined ? 'spawn-error' : 'error',
        id: child.id,
        error: { message, code: WORKER_CHILD_ABANDONED_CODE }
      })
    }
  }
}

function defaultWorkerFactory(): Worker {
  const workerPath = resolveWorkerThreadEntryPath(
    currentWorkerEntryLayout(__dirname),
    WORKER_ENTRY_FILENAME
  )
  // A missing entry surfaces as the worker's own error before it answers, which retires the host (failedToStart).
  return spawnWorkerThread(workerPath, { name: 'orca-child-process-spawner' })
}

let sharedHost: WorkerThreadChildProcessHost | null = null
let isolatedFactory: WorkerThreadFactory | null = null

/**
 * Linux: spawn on a worker in a utility process instead of main. Chromium starts utility processes
 * with a fresh fd table, so their children never hold main's Chromium sockets. Install before the
 * first spawn.
 */
export function installIsolatedChildSpawner(factory: WorkerThreadFactory): void {
  isolatedFactory = factory
  // A host made before this keeps serving its own children and retires when they end.
  sharedHost = null
}

/** True when children spawned through this module run outside main's process. */
export function childSpawnerIsIsolated(): boolean {
  return isolatedFactory !== null
}

function shared(): WorkerThreadChildProcessHost {
  sharedHost ??= isolatedFactory
    ? new WorkerThreadChildProcessHost(isolatedFactory, { tagSpawns: true })
    : new WorkerThreadChildProcessHost(defaultWorkerFactory)
  return sharedHost
}
const workerDisabled = (): boolean => process.env.ORCA_CHILD_PROCESS_WORKER_DISABLED === '1'

export function spawnProcessOnWorkerThread(spec: WorkerThreadChildSpec): WorkerThreadChildProcess {
  // The worker has its own module state, so only main knows WSL was proven absent.
  assertWslNotLatchedAbsent(spec.program)
  return shared().spawn(spec)
}

/** Resolves true once a spawn would reach a worker that loaded its entry; false means spawn locally. */
export function whenSpawnWorkerReady(): Promise<boolean> {
  return workerDisabled() ? Promise.resolve(false) : shared().whenReady()
}

/** Never waits: false while the worker boots (the boot starts), so the caller spawns locally meanwhile. */
export function spawnWorkerReadyNow(): boolean {
  return !workerDisabled() && shared().isReady()
}

/** True when a spawn now would reach a live worker; callers that must not fail can spawn locally instead. */
export function canSpawnOnWorkerThread(): boolean {
  return shared().available()
}
