import { readFile } from 'node:fs/promises'
import {
  getRuntimeRestartMarkerPath,
  isRuntimeRestartOverdue,
  parseFreshRuntimeRestartMarker,
  RUNTIME_RESTART_OVERDUE_MS,
  type RuntimeRestartMarker
} from '../../../shared/remote-runtime/bootstrap/runtime-restart-marker'
import { isProcessRunning } from './runtime-pid-liveness'

export const RUNTIME_RESTART_WAIT_BUDGET_MS = 30_000
const RUNTIME_RESTART_POLL_MS = 1_000
// A restarted runtime publishes metadata about half a second before its graph serves; back off from there.
export const RUNTIME_GRAPH_READY_FIRST_POLL_MS = 250

// Socket errors that fire before connect, so the request was never sent.
const CONNECT_FAILURE_CODES = new Set(['ECONNREFUSED', 'ENOENT', 'ENOTSOCK'])

export function isConnectFailureCode(code: unknown): boolean {
  return typeof code === 'string' && CONNECT_FAILURE_CODES.has(code)
}

/** A restart still in progress: fresh, and not one whose old process stayed alive. */
export async function readActiveRuntimeRestart(
  userDataPath: string,
  now = Date.now()
): Promise<RuntimeRestartMarker | null> {
  let raw: string
  try {
    raw = await readFile(getRuntimeRestartMarkerPath(userDataPath), 'utf8')
  } catch {
    return null
  }
  const marker = parseFreshRuntimeRestartMarker(raw, now)
  if (!marker) {
    return null
  }
  // Past the forced-exit watchdog, a live quitting pid means the install was abandoned.
  if (isRuntimeRestartOverdue(marker, now) && isProcessRunning(marker.pid)) {
    return null
  }
  return marker
}

export type RuntimeRestartWaitOptions = {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  budgetMs?: number
}

/** Paces connect retries while a restart marker is fresh, within one budget per command. */
export class RuntimeRestartWait {
  private deadline: number | null = null
  /** The last active restart seen; set once a wait has started. */
  restart: RuntimeRestartMarker | null = null
  /** The runtime that last answered this command; what it learned may not hold for a replacement. */
  servedBy: string | null = null
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly budgetMs: number

  constructor(
    private readonly userDataPath: string,
    options: RuntimeRestartWaitOptions = {}
  ) {
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.budgetMs = options.budgetMs ?? RUNTIME_RESTART_WAIT_BUDGET_MS
  }

  /** A served request ends the restart, so a long-lived client gets a fresh budget next time. */
  settle(runtimeId: string): void {
    this.deadline = null
    this.restart = null
    this.servedBy = runtimeId
  }

  /** A status answer names the runtime but doesn't prove its graph serves, so the restart stays open. */
  noteAnsweredBy(runtimeId: string): void {
    this.servedBy = runtimeId
  }

  /** Sleeps within the budget a wait already started; false once it is spent or none started. */
  async pause(ms = RUNTIME_RESTART_POLL_MS): Promise<boolean> {
    if (this.deadline === null) {
      return false
    }
    const remaining = this.deadline - this.now()
    if (remaining <= 0) {
      return false
    }
    await this.sleep(Math.min(ms, remaining))
    return true
  }

  /** True after pausing when another unsent attempt is worth making; false at once without a live restart. */
  async shouldRetry(): Promise<boolean> {
    const now = this.now()
    const restart = await readActiveRuntimeRestart(this.userDataPath, now)
    if (!restart) {
      return false
    }
    this.restart = restart
    // An overdue restart may never come back, so it costs no wait.
    if (isRuntimeRestartOverdue(restart, now)) {
      return false
    }
    // The Windows installer waits on, then kills, processes running from the install folder, as this CLI does.
    if (restart.reason === 'update' && process.platform === 'win32') {
      return false
    }
    // Stop waiting when the restart turns overdue, rather than report a long-past restart as in progress.
    this.deadline ??= Math.min(now + this.budgetMs, restart.writtenAt + RUNTIME_RESTART_OVERDUE_MS)
    const remaining = this.deadline - now
    if (remaining <= 0) {
      // A later call on a reused client gets its own budget.
      this.deadline = null
      return false
    }
    await this.sleep(Math.min(RUNTIME_RESTART_POLL_MS, remaining))
    return true
  }
}
