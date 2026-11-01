// Why: agentcookie (https://github.com/mvanhorn/agentcookie) is an optional
// companion tool that decrypts the user's real browser session. When the user
// opts in and names the executable to trust, orca's embedded browser can stay
// signed in automatically instead of requiring a manual "import cookies" step:
// orca pulls the current session from `agentcookie export` and loads it through
// its own validated importer, on startup and on an interval. Without both of
// those settings nothing is executed and orca behaves exactly as before.
import { accessSync, constants as fsConstants } from 'node:fs'
import { execFile } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'

import { importCookiesFromJson } from './cookies/browser-cookie-import'
import { diag, summarizeCookieImportError } from './cookies/browser-cookie-import-diagnostics'
import type { BrowserCookieImportResult } from '../../shared/browser-workspace-types'

const execFileAsync = promisify(execFile)

// Why: a full session export can be large (a busy profile has thousands of
// cookies); keep the stdout buffer generous so the pull never truncates.
const EXPORT_MAX_BUFFER = 64 * 1024 * 1024
const EXPORT_TIMEOUT_MS = 30_000

export const DEFAULT_AGENTCOOKIE_SYNC_INTERVAL_MS = 5 * 60 * 1000

export type AgentcookieSyncStatus = {
  detected: boolean
  lastSyncAt: number | null
  lastImportedCount: number | null
}

// Why: never search PATH. The export output becomes session cookies, so a
// matching filename planted in an earlier PATH directory must not get executed.
export function resolveApprovedAgentcookie(approvedPath: string | null | undefined): string | null {
  if (!approvedPath || !isAbsolute(approvedPath)) {
    return null
  }
  try {
    accessSync(approvedPath, fsConstants.X_OK)
    return approvedPath
  } catch {
    return null
  }
}

// pullAgentcookieSession runs `agentcookie export` and imports its JSON into the
// target partition via orca's own pipeline. Returns null when no binary was
// given or the export fails (not configured yet, no cookies, etc.) so the caller
// can treat it as "nothing to sync" rather than an error.
export async function pullAgentcookieSession(
  targetPartition: string,
  binary: string | null
): Promise<BrowserCookieImportResult | null> {
  if (!binary) {
    return null
  }
  let stdout: string
  try {
    const result = await execFileAsync(binary, ['export'], {
      encoding: 'utf-8',
      timeout: EXPORT_TIMEOUT_MS,
      maxBuffer: EXPORT_MAX_BUFFER
    })
    stdout = result.stdout
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error ? error.stderr : null
    diag(`agentcookie export failed: ${summarizeCookieImportError(stderr || error)}`)
    return null
  }
  if (!stdout.trim()) {
    return null
  }
  return importCookiesFromJson(stdout, targetPartition)
}

export type AgentcookieSessionSyncOptions = {
  targetPartition: string
  isEnabled: () => boolean
  getApprovedBinaryPath: () => string | null | undefined
  onStatus?: (status: AgentcookieSyncStatus) => void
  intervalMs?: number
}

// AgentcookieSessionSync keeps the browser partition signed in from agentcookie:
// an immediate pull on start, then a debounced interval. Nothing is executed
// until the feature is enabled and a binary is approved, and both are re-read on
// every tick so turning it on takes effect without a restart. One pull runs at a
// time so a slow export never overlaps the interval.
export class AgentcookieSessionSync {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  private readonly intervalMs: number

  constructor(private readonly options: AgentcookieSessionSyncOptions) {
    this.intervalMs = options.intervalMs ?? DEFAULT_AGENTCOOKIE_SYNC_INTERVAL_MS
  }

  start(): void {
    if (this.timer) {
      return
    }
    const binary = resolveApprovedAgentcookie(this.options.getApprovedBinaryPath())
    this.options.onStatus?.({
      detected: binary !== null,
      lastSyncAt: null,
      lastImportedCount: null
    })
    if (binary && this.options.isEnabled()) {
      this.syncInBackground()
    }
    this.timer = setInterval(() => {
      if (this.options.isEnabled()) {
        this.syncInBackground()
      }
    }, this.intervalMs)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  // syncNow pulls once. Concurrency-guarded so the interval can't stack pulls.
  async syncNow(): Promise<AgentcookieSyncStatus> {
    const binary = resolveApprovedAgentcookie(this.options.getApprovedBinaryPath())
    if (!binary || this.running) {
      const status = { detected: binary !== null, lastSyncAt: null, lastImportedCount: null }
      this.options.onStatus?.(status)
      return status
    }
    this.running = true
    try {
      const result = await pullAgentcookieSession(this.options.targetPartition, binary)
      const imported = result && result.ok ? result.summary.importedCookies : null
      const status: AgentcookieSyncStatus = {
        detected: true,
        lastSyncAt: Date.now(),
        lastImportedCount: imported
      }
      this.options.onStatus?.(status)
      return status
    } finally {
      this.running = false
    }
  }

  // Why: nobody awaits a startup or interval pull, and the import or the status
  // callback can still reject, so report it here rather than leave it unhandled.
  private syncInBackground(): void {
    this.syncNow().catch((error: unknown) => {
      diag(`agentcookie sync failed: ${summarizeCookieImportError(error)}`)
    })
  }
}
