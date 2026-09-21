import { existsSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import type { WorkerThreadFactory } from '../lazy-worker-thread-host'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath,
  type WorkerEntryLayout
} from '../worker-thread-entry-path'
import { WorkerThreadRequestQueue } from '../worker-thread-request-queue'
import {
  PORT_SCAN_COMMAND_TIMEOUT_MS,
  PortScanCommandTimeoutError,
  type PortScanCommandRequest,
  type PortScanCommandResponse
} from './port-scan-command-protocol'

// Why (#11161): a lazily-spawned, unref'd worker runs the port scan's probe
// spawns off the Electron main-process event loop, because libuv performs
// process creation inline on the calling thread. This module owns only the
// probe-command leg; the request half (FIFO one-at-a-time dispatch, per-call
// deadlines, respawn-on-fault) is WorkerThreadRequestQueue and the thread's
// lifetime is LazyWorkerThreadHost, both shared with
// src/main/ai-vault/session-scanner-opencode-sqlite-worker-client.ts and
// src/main/usage/usage-scan-worker-client.ts.
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

/**
 * Main-thread bridge that runs port-scan probe commands on a persistent worker
 * thread. The shared request queue dispatches one command at a time (FIFO),
 * times each call out from dispatch, respawns after faults (capped by
 * `MAX_CONSECUTIVE_DEATHS`), tears the worker down after `IDLE_TEARDOWN_MS`, and
 * fails closed when no worker can be spawned rather than moving process creation
 * back onto the main thread.
 */
export class PortScanCommandClient {
  private readonly requests: WorkerThreadRequestQueue<
    PortScanCommandRequest,
    PortScanCommandResponse
  >

  constructor(options: { workerFactory: PortScanWorkerFactory; log?: (message: string) => void }) {
    const log = options.log ?? ((message: string) => console.warn(message))
    this.requests = new WorkerThreadRequestQueue({
      factory: options.workerFactory,
      idleTeardownMs: IDLE_TEARDOWN_MS,
      maxConsecutiveDeaths: MAX_CONSECUTIVE_DEATHS,
      // Why (#11161): one at a time. uv_spawn blocks the worker's own loop, so a
      // second concurrent request would have its deadline armed while the first
      // spawn is still stalling the thread, producing a false timeout.
      queueCap: {
        maxQueuedCalls: MAX_QUEUED_CALLS,
        // Names the dropped command: pile-up is per-probe, so the log is
        // useless without knowing which of lsof/ps/netstat was shed.
        describeFull: (request) => `Port scan command queue is full; dropped ${request.command}.`
      },
      createUnavailableError: (message) => new PortScanWorkerUnavailableError(message),
      // Plain wording on purpose: a wedged worker is not a command timeout and
      // must never feed the scanner's timeout backoff.
      describeTimeout: (timeoutMs) => `Port scan probe worker stalled after ${timeoutMs}ms`,
      describeExit: (code) => `Port scan probe worker exited with code ${code}`,
      describeCrashLoop: (lastError) => `Port scan probe worker crashed repeatedly (${lastError})`,
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
  async run(command: string, args: string[]): Promise<PortScanCommandResult> {
    const response = await this.requests.dispatch((id) => ({ id, command, args }), CALL_DEADLINE_MS)
    if (response.ok) {
      return { stdout: response.stdout, spawnMs: response.spawnMs }
    }
    throw response.timedOut
      ? new PortScanCommandTimeoutError(response.error)
      : new Error(response.error)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const WORKER_ENTRY_FILENAME = 'port-scan-command-worker-entry.js'

export type { WorkerEntryLayout }

/**
 * Resolve the built probe worker entry for one runtime layout.
 * @param layout - Packaged flag plus both candidate roots.
 * @returns Path passed to `new Worker()`.
 */
export function resolveWorkerEntryPath(layout: WorkerEntryLayout): string {
  return resolveWorkerThreadEntryPath(layout, WORKER_ENTRY_FILENAME)
}

function defaultWorkerFactory(): Worker {
  const workerPath = resolveWorkerEntryPath(currentWorkerEntryLayout(__dirname))
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
