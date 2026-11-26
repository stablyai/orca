import type { Worker } from 'node:worker_threads'
import { app, MessageChannelMain, utilityProcess } from 'electron'
import type { CrashReportBreadcrumbData } from '../../shared/crash-reporting/crash-reporting'
import { recordDurableCrashBreadcrumb } from '../crash-reporting/breadcrumbs/durable-crash-breadcrumb'
import {
  UtilityWorkerHostCrashLoop,
  type UtilityWorkerHostCrashCap
} from './utility-worker-host-crash-loop'
import { HostedWorker } from './hosted-worker'
import { asError, stopChild, type Host } from './utility-worker-host-process'
import {
  recordUtilityWorkerHeapPressure,
  utilityWorkerHostExitData,
  utilityWorkerOutOfMemoryData
} from './utility-worker-heap-report'
import {
  UtilityWorkerHostPausedError,
  type HostedWorkerThread,
  type UtilityWorkerHostEvent,
  type UtilityWorkerHostRequest,
  type UtilityWorkerSpawn
} from './utility-worker-host-protocol'

/** A host that cannot start in time loses its workers to in-process threads. */
const HOST_READY_TIMEOUT_MS = 4_000
// A slow start retries later, not never: in-process readers are back in main's V8 cage.
const RETRY_FIRST_MS = 1_000
const RETRY_MAX_MS = 60_000
const HOST_IDLE_EXIT_MS = 30_000

/** Electron stops utility processes as it quits; those exits are not failures. */
let quitting = false

/** A new thread that can't get memory in a crowded host could load in a healthy one. */
const RESOURCE_START_FAILURES = new Set(['ERR_WORKER_OUT_OF_MEMORY', 'ERR_WORKER_INIT_FAILED'])

/**
 * Runs worker threads in one Electron utility process. Electron main and its worker threads share
 * one V8 pointer cage (~3.25 GB), so a worker's heap there can push main into a fatal OOM; here it
 * has its own, and a host OOM only fails the workers it holds. Each worker talks to its consumer
 * over its own MessagePort; main only starts, counts and stops the process.
 */
export class UtilityWorkerHost {
  private host?: Host
  /** An entry that cannot load in the host never will; a slow or dead start may recover. */
  private readonly neverHost = new Set<string>()
  private retryAt = 0
  private retryMs = 0
  private nextId = 0
  private readonly crashLoop?: UtilityWorkerHostCrashLoop

  constructor(
    private readonly serviceName: string,
    private readonly entryPath: () => string,
    private readonly spawnInProcess: (spawn: UtilityWorkerSpawn) => Worker,
    /** The owner's account of what this host's workers were doing, for exit and OOM breadcrumbs. */
    private readonly exitContext?: (
      workers: readonly HostedWorkerThread[]
    ) => CrashReportBreadcrumbData,
    crashCap?: UtilityWorkerHostCrashCap,
    /** Serialized reply bytes main may hold unconsumed; past it the host holds replies itself. */
    private readonly relayBudgetBytes?: number
  ) {
    this.crashLoop = crashCap && new UtilityWorkerHostCrashLoop(serviceName, crashCap)
    app.once('will-quit', () => {
      quitting = true
    })
  }

  spawn(spawn: UtilityWorkerSpawn): HostedWorkerThread {
    this.crashLoop?.throwIfPaused()
    if (this.neverHost.has(spawn.filename) || Date.now() < this.retryAt) {
      return this.spawnInProcess(spawn)
    }
    let host: Host
    try {
      host = this.liveHost()
    } catch {
      this.backOff()
      return this.spawnInProcess(spawn)
    }
    const id = ++this.nextId
    const { port1, port2 } = new MessageChannelMain()
    const worker = new HostedWorker(id, spawn, port2, this.serviceName, {
      startFailed: (error) => this.startFailed(host, worker, error),
      // Counted before its consumer hears, so a retry can't start a host past the cap; its exit
      // is still on the way, and a request arriving meanwhile must start a fresh host.
      portLost: () => {
        if (!host.retired && host.ready) {
          host.exitContext ??= this.exitContext?.([...host.workers.values()])
          this.countLoss(host)
          if (this.host === host) {
            this.host = undefined
          }
        }
      },
      outOfMemory: () => this.workerOutOfMemory(host, worker),
      // A lost host keeps its workers listed for the exit breadcrumb; retiring it clears them.
      exited: (exited) => {
        if (!host.lossCounted && host.workers.get(id) === exited) {
          host.workers.delete(id)
          this.scheduleIdleExit(host)
        }
      },
      ack: (seq) => this.ack(host, seq)
    })
    host.workers.set(id, worker)
    clearTimeout(host.idleTimer)
    host.idleTimer = undefined
    // Shared memory can't cross into the host; only an in-process worker gets these.
    const { inProcessWorkerData: _inProcess, ...hosted } = spawn
    const request: Extract<UtilityWorkerHostRequest, { type: 'spawn' }> = {
      type: 'spawn',
      id,
      ...hosted
    }
    if (host.ready) {
      try {
        host.child.postMessage(request, [port1])
      } catch (error) {
        // Uncloneable workerData throws here, as a node Worker's constructor would.
        port1.close()
        worker.finish(1)
        throw error
      }
    } else {
      host.queued.push({ request, port: port1 })
    }
    return worker
  }

  get pauseMessage(): string | null {
    return this.crashLoop?.pauseMessage ?? null
  }

  /** A user asked again: clear the crash history and let the next spawn start a fresh host. */
  retry(): void {
    this.crashLoop?.retry()
  }

  private liveHost(): Host {
    if (this.host && !this.host.retired) {
      return this.host
    }
    const child = utilityProcess.fork(this.entryPath(), [], {
      serviceName: this.serviceName,
      stdio: ['ignore', 'ignore', 'pipe']
    })
    const host: Host = {
      child,
      ready: false,
      queued: [],
      workers: new Map(),
      retired: false,
      lossCounted: false,
      readyTimer: setTimeout(() => this.giveUp(host, 'ready-timeout'), HOST_READY_TIMEOUT_MS)
    }
    this.host = host
    child.stderr?.on('data', (chunk: Buffer) => {
      console.error(`[${this.serviceName}]`, String(chunk).trimEnd())
    })
    child.on('message', (event: UtilityWorkerHostEvent) => this.receive(host, event))
    // A V8 fatal error is always followed by exit, which reports it; unheard, it would throw in main.
    child.on('error', () => undefined)
    child.on('exit', (code) => this.exited(host, code))
    return host
  }

  private receive(host: Host, event: UtilityWorkerHostEvent): void {
    if (host.retired) {
      return
    }
    if (event.type === 'heap') {
      host.heap = event.report
      recordUtilityWorkerHeapPressure(this.serviceName, event.report, [...host.workers.values()])
      return
    }
    clearTimeout(host.readyTimer)
    host.ready = true
    this.retryMs = 0
    if (this.relayBudgetBytes !== undefined) {
      // Before any spawn, so no worker's reply is ever relayed past an unset budget.
      host.child.postMessage({ type: 'budget', bytes: this.relayBudgetBytes })
    }
    for (const { request, port } of host.queued.splice(0)) {
      try {
        host.child.postMessage(request, [port])
      } catch (error) {
        // One spawn that can't be sent must not strand the ones queued behind it.
        port.close()
        host.workers.get(request.id)?.fail(asError(error), 1)
      }
    }
  }

  /** On the process channel, since the worker's port closes once main reads its exit. */
  private ack(host: Host, seq: number): void {
    if (host.retired) {
      return
    }
    try {
      host.child.postMessage({ type: 'ack', seq } satisfies UtilityWorkerHostRequest)
    } catch {
      // The host is exiting; its budget goes with it.
    }
  }

  private backOff(): void {
    this.retryMs = Math.min(Math.max(this.retryMs * 2, RETRY_FIRST_MS), RETRY_MAX_MS)
    this.retryAt = Date.now() + this.retryMs
  }

  private countLoss(host: Host): void {
    if (!host.lossCounted && !quitting) {
      host.lossCounted = true
      this.crashLoop?.record()
    }
  }

  /** Only this entry moves in-process: it never loaded, so it never ran; the host's others did. */
  private startFailed(
    host: Host,
    worker: HostedWorker,
    error: NodeJS.ErrnoException | undefined
  ): void {
    host.workers.delete(worker.id)
    if (error?.code && RESOURCE_START_FAILURES.has(error.code)) {
      this.workerOutOfMemory(host, worker, error.code)
      worker.fail(error, 1)
    } else {
      this.neverHost.add(worker.spawn.filename)
      recordDurableCrashBreadcrumb('utility_worker_host_unavailable', {
        serviceName: this.serviceName,
        reason: 'worker-start-failed',
        role: worker.spawn.name,
        workers: host.workers.size,
        retryMs: null
      })
      this.adoptOrFail(worker)
    }
    this.scheduleIdleExit(host)
  }

  private adoptOrFail(worker: HostedWorker): void {
    const paused = this.pauseMessage
    if (paused !== null) {
      // Paused work never moves into main, which shares the V8 cage the host keeps it out of.
      worker.fail(new UtilityWorkerHostPausedError(paused), 1)
      return
    }
    try {
      worker.adopt(this.spawnInProcess(worker.spawn))
    } catch (error) {
      worker.fail(asError(error), 1)
    }
  }

  /** The host outlives a worker's own OOM, so no exit breadcrumb would name what it was doing. */
  private workerOutOfMemory(host: Host, worker: HostedWorker, code?: string): void {
    // A lost host's exit breadcrumb already names its workers' reads.
    if (!quitting && !host.lossCounted) {
      recordDurableCrashBreadcrumb('worker_thread_failed', {
        ...utilityWorkerOutOfMemoryData(this.serviceName, worker, host.heap, code),
        // Before the worker fails, which ends what its owner was waiting on.
        ...this.exitContext?.([worker])
      })
    }
    // A worker's own failure, heard while its host drains, is part of the host loss already counted.
    if (!host.lossCounted) {
      this.crashLoop?.record()
    }
  }

  private scheduleIdleExit(host: Host): void {
    if (host.retired || host.workers.size > 0 || host.idleTimer) {
      return
    }
    host.idleTimer = setTimeout(() => {
      if (host.workers.size === 0) {
        this.retire(host)
        stopChild(host)
      }
    }, HOST_IDLE_EXIT_MS)
    host.idleTimer.unref?.()
  }

  /** A host that never got ready never received a spawn, so its workers move in-process unrun. */
  private giveUp(host: Host, reason: 'ready-timeout' | 'exited-before-ready'): void {
    if (host.retired) {
      return
    }
    this.backOff()
    recordDurableCrashBreadcrumb('utility_worker_host_unavailable', {
      serviceName: this.serviceName,
      reason,
      workers: host.workers.size,
      retryMs: this.retryMs
    })
    const workers = [...host.workers.values()]
    this.retire(host)
    stopChild(host)
    for (const worker of workers) {
      if (worker.terminating) {
        worker.finish(0)
      } else {
        // One worker that can't start in-process must not strand the rest.
        this.adoptOrFail(worker)
      }
    }
  }

  private exited(host: Host, code: number): void {
    if (host.retired) {
      return
    }
    if (!host.ready) {
      this.giveUp(host, 'exited-before-ready')
      return
    }
    const workers = [...host.workers.values()]
    this.retire(host)
    if (!quitting) {
      recordDurableCrashBreadcrumb('utility_worker_host_exited', {
        ...utilityWorkerHostExitData(this.serviceName, code, workers, host.heap),
        // Before the workers fail, which ends what their owners were waiting on.
        ...(host.exitContext ?? this.exitContext?.(workers))
      })
    }
    // Counted before consumers hear, so none of them can start a host past the cap.
    this.countLoss(host)
    const error = new Error(`${this.serviceName} exited (${code})`)
    for (const worker of workers) {
      worker.failAfterDrain(error, code)
    }
  }

  private retire(host: Host): void {
    host.retired = true
    clearTimeout(host.readyTimer)
    clearTimeout(host.idleTimer)
    host.workers.clear()
    for (const { port } of host.queued.splice(0)) {
      port.close()
    }
    if (this.host === host) {
      this.host = undefined
    }
  }
}
