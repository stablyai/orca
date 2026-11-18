import type { Worker } from 'node:worker_threads'
import {
  app,
  MessageChannelMain,
  utilityProcess,
  type MessagePortMain,
  type UtilityProcess
} from 'electron'
import type { CrashReportBreadcrumbData } from '../../shared/crash-reporting/crash-reporting'
import { recordDurableCrashBreadcrumb } from '../crash-reporting/breadcrumbs/durable-crash-breadcrumb'
import { ManagedOrcadEventWindow } from '../managed-server/lifecycle/orcad-managed-event-window'
import { HostedWorker } from './hosted-worker'
import {
  UTILITY_WORKER_HOST_PAUSED,
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

/** After repeated crashes a capped host refuses work until a user retries; never moves it in-process. */
export type UtilityWorkerHostCrashCap = {
  crashes: number
  windowMs: number
  message: string
  onPause: () => void
}

export class UtilityWorkerHostPausedError extends Error {
  readonly code = UTILITY_WORKER_HOST_PAUSED
}

/** A new thread that can't get memory in a crowded host could load in a healthy one. */
const RESOURCE_START_FAILURES = new Set(['ERR_WORKER_OUT_OF_MEMORY', 'ERR_WORKER_INIT_FAILED'])

type Host = {
  child: UtilityProcess
  ready: boolean
  queued: { request: UtilityWorkerHostRequest; port: MessagePortMain }[]
  workers: Map<number, HostedWorker>
  readyTimer: ReturnType<typeof setTimeout>
  idleTimer?: ReturnType<typeof setTimeout>
  retired: boolean
  /** Its loss is counted once, by whichever of port close or process exit main hears first. */
  lossCounted: boolean
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
  private readonly crashes?: ManagedOrcadEventWindow
  private paused = false

  constructor(
    private readonly serviceName: string,
    private readonly entryPath: () => string,
    private readonly spawnInProcess: (spawn: UtilityWorkerSpawn) => Worker,
    private readonly crashCap?: UtilityWorkerHostCrashCap
  ) {
    if (crashCap) {
      this.crashes = new ManagedOrcadEventWindow(crashCap.windowMs, Date.now)
    }
    app.once('will-quit', () => {
      quitting = true
    })
  }

  spawn(spawn: UtilityWorkerSpawn): HostedWorkerThread {
    if (this.paused) {
      throw new UtilityWorkerHostPausedError(this.crashCap!.message)
    }
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
          this.countLoss(host)
          if (this.host === host) {
            this.host = undefined
          }
        }
      },
      outOfMemory: () => this.recordCrash(),
      // A lost host keeps its workers listed for the exit breadcrumb; retiring it clears them.
      exited: (exited) => {
        if (!host.lossCounted && host.workers.get(id) === exited) {
          host.workers.delete(id)
          this.scheduleIdleExit(host)
        }
      }
    })
    host.workers.set(id, worker)
    clearTimeout(host.idleTimer)
    host.idleTimer = undefined
    const request: UtilityWorkerHostRequest = { type: 'spawn', ...spawn }
    if (host.ready) {
      host.child.postMessage(request, [port1])
    } else {
      host.queued.push({ request, port: port1 })
    }
    return worker
  }

  get pauseMessage(): string | null {
    return this.paused ? this.crashCap!.message : null
  }

  /** A user asked again: clear the crash history and let the next spawn start a fresh host. */
  retry(): void {
    if (!this.paused) {
      return
    }
    recordDurableCrashBreadcrumb('utility_worker_host_retried', { serviceName: this.serviceName })
    this.paused = false
    this.crashes?.forget(this.serviceName)
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
    if (host.retired || event.type !== 'ready') {
      return
    }
    clearTimeout(host.readyTimer)
    host.ready = true
    this.retryMs = 0
    for (const { request, port } of host.queued.splice(0)) {
      host.child.postMessage(request, [port])
    }
  }

  private backOff(): void {
    this.retryMs = Math.min(Math.max(this.retryMs * 2, RETRY_FIRST_MS), RETRY_MAX_MS)
    this.retryAt = Date.now() + this.retryMs
  }

  private countLoss(host: Host): void {
    if (!host.lossCounted && !quitting) {
      host.lossCounted = true
      this.recordCrash()
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
      this.recordCrash()
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
    try {
      worker.adopt(this.spawnInProcess(worker.spawn))
    } catch (error) {
      worker.fail(error instanceof Error ? error : new Error(String(error)), 1)
    }
  }

  private recordCrash(): void {
    if (!this.crashes || !this.crashCap || this.paused) {
      return
    }
    this.crashes.record(this.serviceName)
    const recent = this.crashes.recent(this.serviceName).length
    if (recent >= this.crashCap.crashes) {
      this.paused = true
      recordDurableCrashBreadcrumb('utility_worker_host_paused', {
        serviceName: this.serviceName,
        crashes: recent
      })
      this.crashCap.onPause()
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
      const data: CrashReportBreadcrumbData = {
        serviceName: this.serviceName,
        code,
        workers: workers.length
      }
      workers.forEach((worker, index) => {
        data[`w${index}_role`] = worker.spawn.name
        data[`w${index}_lastReply`] = worker.lastReplyType
        data[`w${index}_receivedMB`] = Math.round(worker.receivedBytes / 2 ** 20)
      })
      recordDurableCrashBreadcrumb('utility_worker_host_exited', data)
    }
    // Counted before consumers hear, so none of them can start a host past the cap.
    this.countLoss(host)
    const error = new Error(`${this.serviceName} exited (${code})`)
    for (const worker of workers) {
      worker.fail(error, code)
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
