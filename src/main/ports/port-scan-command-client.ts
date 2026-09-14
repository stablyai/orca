import { existsSync } from 'node:fs'
import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-environment'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { LazyWorkerThreadHost, type WorkerThreadFactory } from '../lazy-worker-thread-host'
import {
  PORT_SCAN_COMMAND_TIMEOUT_MS,
  PortScanCommandTimeoutError,
  type PortScanCommandRequest,
  type PortScanCommandResponse
} from './port-scan-command-protocol'

// Why (#11161): a lazily-spawned, unref'd worker runs the port scan's probe
// spawns off the Electron main-process event loop, because libuv performs
// process creation inline on the calling thread. This module owns the request
// half (FIFO one-at-a-time dispatch, per-call deadlines, respawn-on-fault); the
// thread's own lifetime belongs to LazyWorkerThreadHost, shared with
// src/main/ai-vault/session-scanner-opencode-sqlite-worker-client.ts.
//
// This module used to contain the literal text require('electron'), which fails the
// plain-Node entry guard even inside a try/catch. It reads the AppEnvironment port
// instead, so it is now safe to reach from a fork entry.

// Why: the worker's own loop absorbs the spawn stall, so the client only needs
// a backstop for a wedged thread. Kept at 30s because a scan sits on the
// user-blocking localhost-label allowlist path (src/main/ipc/
// localhost-worktree-labels.ts).
export const WORKER_STALL_GRACE_MS = 26_000
export const CALL_DEADLINE_MS = PORT_SCAN_COMMAND_TIMEOUT_MS + WORKER_STALL_GRACE_MS
// Deliberately far longer than the 30s scan cadence so a visible window does not
// re-create the worker every tick; the renderer stops the interval when hidden,
// so this is effectively the hidden-window teardown.
export const IDLE_TEARDOWN_MS = 5 * 60_000
export const MAX_CONSECUTIVE_DEATHS = 3
// One scan issues at most three commands; anything beyond this is pile-up.
export const MAX_QUEUED_CALLS = 8

export type PortScanCommandResult = { stdout: string; spawnMs: number }
export type PortScanWorkerFactory = WorkerThreadFactory

// Distinguishes "no worker at all" from a timeout or crash so the scanner can
// log it once and callers never mistake it for a command timeout.
class PortScanWorkerUnavailableError extends Error {}

/** True when a scan failed because the probe worker could not be started. */
export function isPortScanWorkerUnavailableError(error: unknown): boolean {
  return error instanceof PortScanWorkerUnavailableError
}

type PendingCall = {
  request: PortScanCommandRequest
  resolve: (value: PortScanCommandResult) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout | null
}

/**
 * Main-thread bridge that runs port-scan probe commands on a persistent worker
 * thread. Dispatches one command at a time (FIFO), times each call out from
 * dispatch, respawns after faults (capped by `MAX_CONSECUTIVE_DEATHS`), tears
 * the worker down after `IDLE_TEARDOWN_MS`, and fails closed when no worker can
 * be spawned rather than moving process creation back onto the main thread.
 */
export class PortScanCommandClient {
  private active: PendingCall | null = null
  private queue: PendingCall[] = []
  private consecutiveDeaths = 0
  private nextId = 1
  private readonly host: LazyWorkerThreadHost<PortScanCommandResponse>

  constructor(options: { workerFactory: PortScanWorkerFactory; log?: (message: string) => void }) {
    const log = options.log ?? ((message: string) => console.warn(message))
    this.host = new LazyWorkerThreadHost<PortScanCommandResponse>({
      factory: options.workerFactory,
      idleTeardownMs: IDLE_TEARDOWN_MS,
      onMessage: (response) => this.onMessage(response),
      onError: (error) => this.onWorkerFault(error),
      onExit: (code) => this.onWorkerExit(code),
      isIdle: () => !this.active && this.queue.length === 0,
      // Why (#11161): never fall back to in-process execFile here; a missing
      // bundle must report port scanning as unavailable rather than reintroduce
      // the main-thread freeze this worker boundary exists to prevent.
      onUnavailable: (err) =>
        log(`[workspace-ports] probe worker unavailable. ${errorMessage(err)}`)
    })
  }

  /**
   * Run one probe command on the worker.
   * @param command - Executable name (lsof, ps, netstat, powershell.exe).
   * @param args - Argument vector passed verbatim to execFile.
   * @returns The command's stdout plus its measured process-creation latency.
   */
  run(command: string, args: string[]): Promise<PortScanCommandResult> {
    return new Promise((resolve, reject) => {
      if (this.queue.length >= MAX_QUEUED_CALLS) {
        reject(new Error(`Port scan command queue is full; dropped ${command}.`))
        return
      }
      // A fresh burst from full idle starts a new scan: clear any death count
      // carried from a prior scan so the respawn cap can't drain this scan early.
      if (!this.active && this.queue.length === 0) {
        this.consecutiveDeaths = 0
      }
      this.queue.push({
        request: { id: this.nextId++, command, args },
        resolve,
        reject,
        timer: null
      })
      this.pump()
    })
  }

  private pump(): void {
    if (this.active || this.queue.length === 0) {
      return
    }
    const worker = this.host.ensure()
    if (!worker) {
      this.failQueuedAsUnavailable()
      return
    }
    const call = this.queue.shift()
    if (!call) {
      return
    }
    this.active = call
    this.host.clearIdleTimer()
    // Why (#11161): one at a time. uv_spawn blocks the worker's own loop, so a
    // second concurrent request would have its deadline armed while the first
    // spawn is still stalling the thread, producing a false timeout.
    call.timer = setTimeout(() => this.onDeadline(call), CALL_DEADLINE_MS)
    call.timer.unref?.()
    worker.postMessage(call.request)
  }

  private onMessage(response: PortScanCommandResponse): void {
    const call = this.active
    if (!call || call.request.id !== response.id) {
      return
    }
    this.consecutiveDeaths = 0
    if (response.ok) {
      this.settle(call, () => call.resolve({ stdout: response.stdout, spawnMs: response.spawnMs }))
    } else {
      const error = response.timedOut
        ? new PortScanCommandTimeoutError(response.error)
        : new Error(response.error)
      this.settle(call, () => call.reject(error))
    }
    this.afterSettle()
  }

  private onDeadline(call: PendingCall): void {
    if (this.active !== call) {
      return
    }
    // Plain Error on purpose: a wedged worker is not a command timeout and must
    // never feed the scanner's timeout backoff.
    this.onWorkerFault(new Error(`Port scan probe worker stalled after ${CALL_DEADLINE_MS}ms`))
  }

  private onWorkerExit(code: number): void {
    // A clean self-exit is not a death, but the stale handle must be dropped or
    // the next dispatch would post into a dead worker and stall to its deadline.
    if (code === 0 && !this.active && this.queue.length === 0) {
      this.host.destroy()
      return
    }
    this.onWorkerFault(new Error(`Port scan probe worker exited with code ${code}`))
  }

  private onWorkerFault(error: Error): void {
    const failed = this.active
    this.host.destroy()
    this.consecutiveDeaths++
    if (failed) {
      this.settle(failed, () => failed.reject(error))
    }
    if (this.consecutiveDeaths >= MAX_CONSECUTIVE_DEATHS) {
      this.drainQueueAfterCrashLoop(error)
      return
    }
    if (this.queue.length > 0) {
      this.pump()
    }
  }

  private drainQueueAfterCrashLoop(error: Error): void {
    const pending = this.queue
    this.queue = []
    this.consecutiveDeaths = 0
    const drainError = new Error(`Port scan probe worker crashed repeatedly (${error.message})`)
    for (const call of pending) {
      this.settle(call, () => call.reject(drainError))
    }
  }

  private failQueuedAsUnavailable(): void {
    const pending = this.queue
    this.queue = []
    for (const call of pending) {
      this.settle(call, () =>
        call.reject(new PortScanWorkerUnavailableError('port scan probe worker spawn failed'))
      )
    }
  }

  private settle(call: PendingCall, run: () => void): void {
    if (call.timer) {
      clearTimeout(call.timer)
      call.timer = null
    }
    if (this.active === call) {
      this.active = null
    }
    run()
  }

  private afterSettle(): void {
    if (this.queue.length > 0) {
      this.pump()
    } else {
      // Terminating can orphan a probe child mid-spawn; the worker reaps what it
      // can on exit, and every probe here is short-lived.
      this.host.scheduleIdleTeardown()
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const WORKER_ENTRY_FILENAME = 'port-scan-command-worker-entry.js'

/** Where the built worker entry can live: packaged resources or the build dir. */
export type WorkerEntryLayout = {
  isPackaged: boolean
  /** Undefined on a non-Electron host: `process.resourcesPath` is Electron-only. */
  resourcesPath: string | undefined
  moduleDir: string
}

/**
 * Resolve the built worker entry for one runtime layout.
 * @param layout - Packaged flag plus both candidate roots.
 * @returns Path passed to `new Worker()`.
 */
export function resolveWorkerEntryPath(layout: WorkerEntryLayout): string {
  // Packaged builds leave this entry inside app.asar — only forked child
  // processes are asarUnpack'd — so it resolves off resourcesPath rather than
  // the bundler's __dirname, matching the shipped stt/warp/opencode workers.
  // Split out from the electron read so the packaged branch is testable without
  // a packaged build.
  // Why the resourcesPath guard: `isPackaged` is true on orcad too, but
  // `process.resourcesPath` is Electron-only and undefined under plain Node — joining
  // it threw a TypeError rather than failing as a missing worker. A host without an
  // Electron resources tree has no asar to look in, so fall back to the module dir and
  // let the caller report a missing worker honestly.
  if (layout.isPackaged && layout.resourcesPath) {
    return join(layout.resourcesPath, 'app.asar', 'out', 'main', WORKER_ENTRY_FILENAME)
  }
  return join(layout.moduleDir, WORKER_ENTRY_FILENAME)
}

function currentWorkerEntryLayout(): WorkerEntryLayout {
  return {
    isPackaged: hasAppEnvironment() && getAppEnvironment().isPackaged(),
    resourcesPath: process.resourcesPath,
    moduleDir: __dirname
  }
}

function defaultWorkerFactory(): Worker {
  const workerPath = resolveWorkerEntryPath(currentWorkerEntryLayout())
  // Why: a missing built entry must throw synchronously so the client can fail
  // closed before it waits on a worker that can never post a result.
  if (!existsSync(workerPath)) {
    throw new Error(`Port scan command worker entry not found: ${workerPath}`)
  }
  return new Worker(workerPath)
}

let sharedClient: PortScanCommandClient | null = null

/**
 * Run a port-scan probe command through the process-wide worker client.
 * @param command - Executable name (lsof, ps, netstat, powershell.exe).
 * @param args - Argument vector passed verbatim to execFile.
 * @returns The command's stdout plus its measured process-creation latency.
 */
export function runPortScanCommand(
  command: string,
  args: string[]
): Promise<PortScanCommandResult> {
  sharedClient ??= new PortScanCommandClient({ workerFactory: defaultWorkerFactory })
  return sharedClient.run(command, args)
}
