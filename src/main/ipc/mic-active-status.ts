import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'

const HELPER_EXECUTABLE = 'orca-mic-active-status'
const HELPER_TIMEOUT_MS = 4000

let cachedHelperPath: string | null | undefined

/**
 * Resolves the bundled mic-active-status helper binary.
 *
 * Why: same placement rationale as the notification-status helper — it must
 * live in Contents/MacOS next to the Electron executable. Dev copies and
 * packaged builds (extraFiles) both place it there.
 */
function resolveHelperPath(): string | null {
  if (cachedHelperPath !== undefined) {
    return cachedHelperPath
  }
  if (process.platform !== 'darwin') {
    cachedHelperPath = null
    return cachedHelperPath
  }
  const candidate = join(dirname(process.execPath), HELPER_EXECUTABLE)
  cachedHelperPath = existsSync(candidate) ? candidate : null
  return cachedHelperPath
}

/**
 * Reads whether the default input device is actively running, via a helper
 * binary calling CoreAudio's kAudioDevicePropertyDeviceIsRunningSomewhere.
 * Returns null when the helper is unavailable or fails, so callers can treat
 * an unreadable state as "not active" rather than suppressing incorrectly.
 *
 * Why a helper at all: Electron/Node expose no CoreAudio bindings, so a
 * native helper is the only way to read live input-device hardware state.
 *
 * Caveat: this reflects whether *some* process has an open mic stream (the
 * same signal behind the system mic indicator), not whether a specific
 * app's in-app mute (Zoom, Meet, etc.) is engaged — those commonly keep the
 * hardware stream open and discard audio in software while "muted".
 */
let readInFlight: Promise<boolean | null> | null = null

export function readMicActiveStatus(): Promise<boolean | null> {
  const helperPath = resolveHelperPath()
  if (!helperPath) {
    return Promise.resolve(null)
  }
  // Why: concurrent dispatch calls (e.g. agent-finish + terminal-bell in one
  // burst) share one in-flight helper run instead of spawning duplicates.
  if (readInFlight) {
    return readInFlight
  }
  readInFlight = runStatusHelper(helperPath).finally(() => {
    readInFlight = null
  })
  return readInFlight
}

async function runStatusHelper(helperPath: string): Promise<boolean | null> {
  try {
    const result = await runProcess({ program: helperPath, timeoutMs: HELPER_TIMEOUT_MS })
    if (result.code !== 0) {
      return null
    }
    const parsed = JSON.parse(result.stdout.trim()) as { micActive?: boolean | null }
    return typeof parsed.micActive === 'boolean' ? parsed.micActive : null
  } catch {
    return null
  }
}
