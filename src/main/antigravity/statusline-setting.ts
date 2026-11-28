import type { AntigravityStatusLineStatus } from '../../shared/agent-usage/rate-limits/antigravity-statusline-status'
import {
  getAntigravityStatusLineStatus,
  installAntigravityStatusLine,
  removeAntigravityStatusLine
} from './statusline-install'

let queue: Promise<AntigravityStatusLineStatus> | null = null

// Installs and removals queue so a quick off-and-on never interleaves file writes.
export function applyAntigravityStatusLineSetting(
  enabled: boolean
): Promise<AntigravityStatusLineStatus> {
  const run = async (): Promise<AntigravityStatusLineStatus> =>
    enabled ? installAntigravityStatusLine() : removeAntigravityStatusLine()
  const next = (queue ?? Promise.resolve(null)).then(run, run).catch((error: unknown) => {
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

export function readAntigravityStatusLineSettingStatus(): Promise<AntigravityStatusLineStatus> {
  return queue ?? getAntigravityStatusLineStatus()
}

/** On refreshes the managed script after an update; off retries a removal that failed earlier. */
export async function reconcileAntigravityStatusLineAtStartup(enabled: boolean): Promise<void> {
  if (enabled || (await getAntigravityStatusLineStatus()).state !== 'not_installed') {
    await applyAntigravityStatusLineSetting(enabled)
  }
}
