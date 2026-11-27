import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runProcess } from '@orca/process-host'

const HELPER_EXECUTABLE = 'orca-mic-active-status'
const HELPER_TIMEOUT_MS = 4000
// A stalled helper must not hold the banner for its full timeout.
const DELIVERY_DEADLINE_MS = 500

let cachedHelperPath: string | null | undefined

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

/** Whether some process has an open mic stream (Electron exposes no CoreAudio state); null when unreadable. In-app mutes that keep the stream open still read as active. */
let readInFlight: Promise<boolean | null> | null = null

function readMicActiveStatus(): Promise<boolean | null> {
  const helperPath = resolveHelperPath()
  if (!helperPath) {
    return Promise.resolve(null)
  }
  // Share one helper read across simultaneous notifications.
  if (readInFlight) {
    return readInFlight
  }
  readInFlight = runStatusHelper(helperPath).finally(() => {
    readInFlight = null
  })
  return readInFlight
}

export function readMicActiveStatusForDelivery(): Promise<boolean | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), DELIVERY_DEADLINE_MS)
    void readMicActiveStatus().then((micActive) => {
      clearTimeout(timer)
      resolve(micActive)
    })
  })
}

async function runStatusHelper(helperPath: string): Promise<boolean | null> {
  try {
    const result = await runProcess({ program: helperPath, timeoutMs: HELPER_TIMEOUT_MS })
    if (result.timedOut || result.code !== 0) {
      return null
    }
    const parsed: unknown = JSON.parse(result.stdout.trim())
    if (parsed && typeof parsed === 'object' && 'micActive' in parsed) {
      return typeof parsed.micActive === 'boolean' ? parsed.micActive : null
    }
    return null
  } catch {
    return null
  }
}
