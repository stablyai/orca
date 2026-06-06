// Why: agentcookie (https://github.com/mvanhorn/agentcookie) is an optional
// companion tool that decrypts the user's real browser session. When it is
// installed, orca's embedded browser can stay signed in automatically instead
// of requiring a manual "import cookies" step: orca pulls the current session
// from `agentcookie export` and loads it through its own validated importer, on
// startup and on an interval. When agentcookie is not installed, nothing here
// runs and orca behaves exactly as before.
import { accessSync, constants as fsConstants } from 'node:fs'
import { execFile } from 'node:child_process'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'

import { importCookiesFromJson } from './browser-cookie-import'
import type { BrowserCookieImportResult } from '../../shared/types'

const execFileAsync = promisify(execFile)

// Why: a full session export can be large (a busy profile has thousands of
// cookies); keep the stdout buffer generous so the pull never truncates.
const EXPORT_MAX_BUFFER = 64 * 1024 * 1024
const EXPORT_TIMEOUT_MS = 30_000

export const DEFAULT_AGENTCOOKIE_SYNC_INTERVAL_MS = 5 * 60 * 1000

export type AgentcookieSyncStatus = {
  detected: boolean
  lastSyncAt: number | null
  lastImported: number | null
}

// detectAgentcookie resolves an `agentcookie` executable on PATH, or null when
// it is not installed. PATH-scan (no subprocess) so a missing tool is a cheap,
// silent no-op rather than a spawned `which` per check.
export function detectAgentcookie(pathVar = process.env.PATH ?? ''): string | null {
  const exeName = process.platform === 'win32' ? 'agentcookie.exe' : 'agentcookie'
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) {
      continue
    }
    const candidate = join(dir, exeName)
    try {
      accessSync(candidate, fsConstants.X_OK)
      return candidate
    } catch {
      /* not in this dir */
    }
  }
  return null
}

// pullAgentcookieSession runs `agentcookie export` and imports its JSON into the
// target partition via orca's own pipeline. Returns null when agentcookie is
// absent or the export fails (not configured yet, no cookies, etc.) so the
// caller can treat it as "nothing to sync" rather than an error.
export async function pullAgentcookieSession(
  targetPartition: string,
  binary: string | null = detectAgentcookie()
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
  } catch {
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
  onStatus?: (status: AgentcookieSyncStatus) => void
  intervalMs?: number
}

// AgentcookieSessionSync keeps the browser partition signed in from agentcookie:
// an immediate pull on start, then a debounced interval. It is inert when
// agentcookie is not installed or the feature is disabled. One pull runs at a
// time so a slow export never overlaps the interval.
export class AgentcookieSessionSync {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  private readonly intervalMs: number

  constructor(private readonly options: AgentcookieSessionSyncOptions) {
    this.intervalMs = options.intervalMs ?? DEFAULT_AGENTCOOKIE_SYNC_INTERVAL_MS
  }

  start(): void {
    const binary = detectAgentcookie()
    this.options.onStatus?.({ detected: binary !== null, lastSyncAt: null, lastImported: null })
    if (!binary || !this.options.isEnabled()) {
      return
    }
    void this.syncNow()
    this.timer = setInterval(() => {
      if (this.options.isEnabled()) {
        void this.syncNow()
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
    const binary = detectAgentcookie()
    if (!binary || this.running) {
      const status = { detected: binary !== null, lastSyncAt: null, lastImported: null }
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
        lastImported: imported
      }
      this.options.onStatus?.(status)
      return status
    } finally {
      this.running = false
    }
  }
}
