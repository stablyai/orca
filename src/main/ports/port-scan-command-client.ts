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

// libuv spawns block their calling thread; keep probes off Electron main via the shared lazy FIFO worker (#11161).

// Backstop stalled workers within the 30s user-blocking scan budget; spawn stalls are measured in the worker.
export const WORKER_STALL_GRACE_MS = 26_000
export const CALL_DEADLINE_MS = PORT_SCAN_COMMAND_TIMEOUT_MS + WORKER_STALL_GRACE_MS
// Outlast visible 30s polling; hidden windows stop polling and let this teardown expire.
export const IDLE_TEARDOWN_MS = 5 * 60_000
export const MAX_CONSECUTIVE_DEATHS = 3
// One scan issues at most three commands; anything beyond this is pile-up.
export const MAX_QUEUED_CALLS = 8

export type PortScanCommandResult = { stdout: string; spawnMs: number }
export type PortScanWorkerFactory = WorkerThreadFactory

// Worker-unavailable errors must remain distinct from command timeouts and their backoff.
class PortScanWorkerUnavailableError extends Error {}

export function isPortScanWorkerUnavailableError(error: unknown): boolean {
  return error instanceof PortScanWorkerUnavailableError
}

/** Fail closed if the worker cannot start; never move process creation back onto main. */
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
      // Serial dispatch prevents later request deadlines expiring during an earlier uv_spawn stall (#11161).
      queueCap: {
        maxQueuedCalls: MAX_QUEUED_CALLS,
        describeFull: (request) => `Port scan command queue is full; dropped ${request.command}.`
      },
      createUnavailableError: (message) => new PortScanWorkerUnavailableError(message),
      // Worker stalls must not trigger command-timeout backoff.
      describeTimeout: (timeoutMs) => `Port scan probe worker stalled after ${timeoutMs}ms`,
      describeExit: (code) => `Port scan probe worker exited with code ${code}`,
      describeCrashLoop: (lastError) => `Port scan probe worker crashed repeatedly (${lastError})`,
      onUnavailable: (err) =>
        log(`[workspace-ports] probe worker unavailable. ${errorMessage(err)}`)
    })
  }

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

export function resolveWorkerEntryPath(layout: WorkerEntryLayout): string {
  return resolveWorkerThreadEntryPath(layout, WORKER_ENTRY_FILENAME)
}

function defaultWorkerFactory(): Worker {
  const workerPath = resolveWorkerEntryPath(currentWorkerEntryLayout(__dirname))
  // Fail synchronously when no built entry exists rather than await an impossible worker reply.
  if (!existsSync(workerPath)) {
    throw new Error(`Port scan command worker entry not found: ${workerPath}`)
  }
  return new Worker(workerPath)
}

let sharedClient: PortScanCommandClient | null = null

export function runPortScanCommand(
  command: string,
  args: string[]
): Promise<PortScanCommandResult> {
  sharedClient ??= new PortScanCommandClient({ workerFactory: defaultWorkerFactory })
  return sharedClient.run(command, args)
}
