import type { Worker } from 'node:worker_threads'
import { app, utilityProcess, type UtilityProcess } from 'electron'
import type { CrashReportBreadcrumbData } from '../../shared/crash-reporting/crash-reporting'
import { recordDurableCrashBreadcrumb } from '../crash-reporting/breadcrumbs/durable-crash-breadcrumb'
import { HostedWorker } from './hosted-worker'
import type {
  HostedWorkerThread,
  UtilityWorkerHostEvent,
  UtilityWorkerHostRequest,
  UtilityWorkerSpawn
} from './utility-worker-host-protocol'

/** A host that cannot start in time loses its workers to in-process threads. */
const HOST_READY_TIMEOUT_MS = 4_000
// A slow start retries later, not never: in-process readers are back in main's V8 cage.
const RETRY_FIRST_MS = 1_000
const RETRY_MAX_MS = 60_000
const HOST_IDLE_EXIT_MS = 30_000

/** Electron stops utility processes as it quits; those exits are not failures. */
let quitting = false

type Host = {
  child: UtilityProcess
  ready: boolean
  queued: UtilityWorkerHostRequest[]
  workers: Map<number, HostedWorker>
  readyTimer: ReturnType<typeof setTimeout>
  idleTimer?: ReturnType<typeof setTimeout>
  retired: boolean
}

/** A child still launching has no PID to kill yet; kill it once it has one. */
function stopChild(host: Host): void {
  if (!host.child.kill()) {
    host.child.once('spawn', () => host.child.kill())
  }
}

/**
 * Runs worker threads in one Electron utility process. Electron main and its worker threads share
 * one V8 pointer cage (~3.25 GB), so a worker's heap there can push main into a fatal OOM; here it
 * has its own, and a host OOM only fails the workers it holds.
 */
export class UtilityWorkerHost {
  private host?: Host
  /** A reader that cannot load in the host never will; a slow or dead start may recover. */
  private neverHost = false
  private retryAt = 0
  private retryMs = 0
  private nextId = 0

  constructor(
    private readonly serviceName: string,
    private readonly entryPath: () => string,
    private readonly spawnInProcess: (spawn: UtilityWorkerSpawn) => Worker,
    /** The owner's account of what this host's workers were doing, for the exit breadcrumb. */
    private readonly exitContext?: (
      workers: readonly HostedWorkerThread[]
    ) => CrashReportBreadcrumbData
  ) {
    app.once('will-quit', () => {
      quitting = true
    })
  }

  spawn(spawn: UtilityWorkerSpawn): HostedWorkerThread {
    if (this.neverHost || Date.now() < this.retryAt) {
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
    const worker = new HostedWorker(id, spawn, (request) => this.send(host, request))
    host.workers.set(id, worker)
    clearTimeout(host.idleTimer)
    host.idleTimer = undefined
    this.send(host, { type: 'spawn', id, ...spawn })
    return worker
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

  private send(host: Host, request: UtilityWorkerHostRequest): void {
    if (host.retired) {
      return
    }
    if (host.ready) {
      host.child.postMessage(request)
    } else {
      host.queued.push(request)
    }
  }

  private receive(host: Host, event: UtilityWorkerHostEvent): void {
    if (host.retired) {
      return
    }
    if (event.type === 'ready') {
      clearTimeout(host.readyTimer)
      host.ready = true
      this.retryMs = 0
      for (const request of host.queued.splice(0)) {
        host.child.postMessage(request)
      }
      return
    }
    const worker = host.workers.get(event.id)
    if (!worker) {
      return
    }
    // A worker that dies unasked before saying anything could not load here; run it in-process.
    if (!worker.heard && !worker.terminating && event.type !== 'message') {
      this.giveUp(host, 'worker-start-failed')
      return
    }
    if (event.type === 'exit') {
      host.workers.delete(event.id)
      this.scheduleIdleExit(host)
    }
    worker.receive(event)
  }

  private backOff(): void {
    this.retryMs = Math.min(Math.max(this.retryMs * 2, RETRY_FIRST_MS), RETRY_MAX_MS)
    this.retryAt = Date.now() + this.retryMs
  }

  private scheduleIdleExit(host: Host): void {
    if (host.workers.size > 0 || host.idleTimer) {
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

  /** Workers that never ran here move in-process; the rest fail as if their thread died. */
  private giveUp(
    host: Host,
    reason: 'ready-timeout' | 'exited-before-ready' | 'worker-start-failed'
  ): void {
    if (host.retired) {
      return
    }
    if (reason === 'worker-start-failed') {
      this.neverHost = true
    } else {
      this.backOff()
    }
    recordDurableCrashBreadcrumb('utility_worker_host_unavailable', {
      serviceName: this.serviceName,
      reason,
      workers: host.workers.size,
      retryMs: this.neverHost ? null : this.retryMs
    })
    const workers = [...host.workers.values()]
    this.retire(host)
    stopChild(host)
    for (const worker of workers) {
      if (worker.terminating) {
        worker.finish(0)
      } else if (worker.heard) {
        worker.emit('error', new Error(`${this.serviceName} stopped`))
        worker.finish(1)
      } else {
        // One worker that can't start in-process must not strand the rest.
        try {
          worker.adopt(this.spawnInProcess(worker.spawn))
        } catch (error) {
          worker.emit('error', error)
          worker.finish(1)
        }
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
      const data: CrashReportBreadcrumbData = {
        serviceName: this.serviceName,
        code,
        workers: workers.length
      }
      workers.forEach((worker, index) => {
        data[`w${index}_lastReply`] = worker.lastReplyType
        data[`w${index}_receivedMB`] = Math.round(worker.receivedBytes / 2 ** 20)
      })
      // Before the workers fail, which ends what their owners were waiting on.
      Object.assign(data, this.exitContext?.(workers))
      recordDurableCrashBreadcrumb('utility_worker_host_exited', data)
    }
    const error = new Error(`${this.serviceName} exited (${code})`)
    for (const worker of workers) {
      worker.emit('error', error)
      worker.finish(code)
    }
  }

  private retire(host: Host): void {
    host.retired = true
    clearTimeout(host.readyTimer)
    clearTimeout(host.idleTimer)
    host.workers.clear()
    if (this.host === host) {
      this.host = undefined
    }
  }
}
