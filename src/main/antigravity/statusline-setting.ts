import type { AntigravityStatusLineStatus } from '../../shared/agent-usage/rate-limits/antigravity-statusline-status'
import {
  getAntigravityStatusLineStatus,
  installAntigravityStatusLine,
  removeAntigravityStatusLine
} from './statusline-install'

let queue: Promise<AntigravityStatusLineStatus> | null = null
let unsupportedReason: string | null = null

/** The desktop reports a host where agy's status line cannot reach Orca, such as a WSL guest. */
export function setAntigravityStatusLineUnsupported(reason: string | null): void {
  unsupportedReason = reason
}

// One queue serializes installs, removals and the startup check, so none interleaves file writes.
function enqueue(
  task: () => Promise<AntigravityStatusLineStatus>
): Promise<AntigravityStatusLineStatus> {
  const next = (queue ?? Promise.resolve(null)).then(task, task).catch((error: unknown) => {
    console.warn(
      '[antigravity] Could not update the status-line usage hook:',
      error instanceof Error ? error.message : error
    )
    return getAntigravityStatusLineStatus().then((status): AntigravityStatusLineStatus =>
      status.state === 'error'
        ? status
        : { ...status, state: 'error', detail: 'Could not update Antigravity settings.json' }
    )
  })
  queue = next
  return next
}

export function applyAntigravityStatusLineSetting(
  enabled: boolean
): Promise<AntigravityStatusLineStatus> {
  return enqueue(() => (enabled ? installAntigravityStatusLine() : removeAntigravityStatusLine()))
}

export function readAntigravityStatusLineSettingStatus(): Promise<AntigravityStatusLineStatus> {
  if (unsupportedReason !== null) {
    return Promise.resolve({ state: 'unsupported', configPath: '', detail: unsupportedReason })
  }
  return queue ?? getAntigravityStatusLineStatus()
}

/**
 * On refreshes the managed script after an update; off retries a removal that failed earlier.
 * It decides inside the queue and yields to any change the user made since startup.
 */
export function reconcileAntigravityStatusLineAtStartup(
  startedEnabled: boolean,
  isEnabledNow: () => boolean
): Promise<AntigravityStatusLineStatus> {
  return enqueue(async () => {
    if (isEnabledNow() !== startedEnabled) {
      return getAntigravityStatusLineStatus()
    }
    if (startedEnabled) {
      return installAntigravityStatusLine()
    }
    const current = await getAntigravityStatusLineStatus()
    return current.state === 'not_installed' ? current : removeAntigravityStatusLine()
  })
}
