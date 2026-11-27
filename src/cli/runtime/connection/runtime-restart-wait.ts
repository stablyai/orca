import { readFile } from 'node:fs/promises'
import {
  getRuntimeRestartMarkerPath,
  parseFreshRuntimeRestartMarker,
  type RuntimeRestartMarker
} from '../../../shared/remote-runtime/bootstrap/runtime-restart-marker'
import { isProcessRunning } from './runtime-pid-liveness'

// Past the forced-exit watchdog (20 s), a live quitting pid means the install was abandoned.
const ABANDONED_QUIT_AFTER_MS = 45_000
export const RUNTIME_RESTART_WAIT_BUDGET_MS = 30_000
const RUNTIME_RESTART_POLL_MS = 1_000

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
  if (now - marker.writtenAt >= ABANDONED_QUIT_AFTER_MS && isProcessRunning(marker.pid)) {
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

  /** A reached runtime ends the restart, so a long-lived client gets a fresh budget next time. */
  settle(): void {
    this.deadline = null
    this.restart = null
  }

  /** True after pausing when another unsent attempt is worth making; false at once without a live restart. */
  async shouldRetry(): Promise<boolean> {
    const now = this.now()
    const restart = await readActiveRuntimeRestart(this.userDataPath, now)
    if (!restart) {
      return false
    }
    this.restart = restart
    this.deadline ??= now + this.budgetMs
    const remaining = this.deadline - now
    if (remaining <= 0) {
      return false
    }
    await this.sleep(Math.min(RUNTIME_RESTART_POLL_MS, remaining))
    return true
  }
}
