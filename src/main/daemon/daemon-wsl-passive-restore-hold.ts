import { readWslDistroRunningState } from '../wsl-background-distro-gate'
import { wslDistroHoldMessage } from '../../shared/wsl-distro-stopped-hold'
import type { PtySpawnOptions } from '../providers/pty-provider-contract'

/** A probe started this close before a hold still counts as that spawn's own read. */
const WSL_HOLD_READ_ANCHOR_SLACK_MS = 1
/** Even this spawn's own read goes stale: a daemon respawn or a session lock can sit between holds. */
export const WSL_HOLD_READ_MAX_AGE_MS = 2_000

/** The anchor a spawn's first hold reads after; later holds of the same spawn reuse that read. */
export function wslHoldReadAnchor(): number {
  return performance.now() - WSL_HOLD_READ_ANCHOR_SLACK_MS
}

/**
 * Launch restore, a reload, a remount or main's background start (orchestration, automations,
 * recovery) the user did not ask for would start a stopped distro's `wsl.exe` (E9). It starts
 * only when a settled read proves the distro running; a stopped or unanswered read holds it
 * until the user's Start.
 */
export async function holdPassiveRestoreOfStoppedWslDistro(
  opts: Pick<
    PtySpawnOptions,
    | 'wslPassiveRestore'
    | 'wslBackgroundStart'
    | 'wslHoldReadAnchor'
    | 'sessionId'
    | 'isNewSession'
    | 'attachOnly'
  >,
  wslDistro: string | undefined
): Promise<void> {
  const passiveRestore =
    opts.wslPassiveRestore === true && Boolean(opts.sessionId) && opts.isNewSession !== true
  // Background work holds fresh starts too: a new session's `wsl.exe` starts the distro as well.
  if (!wslDistro || opts.attachOnly === true || !(passiveRestore || opts.wslBackgroundStart)) {
    return
  }
  // Without this spawn's anchor the read is fresh; a noted stop or wake still raises the floor.
  const state = await readWslDistroRunningState(wslDistro, {
    ...(opts.wslHoldReadAnchor === undefined
      ? {}
      : {
          startedAfter: Math.max(
            opts.wslHoldReadAnchor,
            performance.now() - WSL_HOLD_READ_MAX_AGE_MS
          )
        }),
    retryUnverifiable: true
  })
  if (state !== 'running') {
    throw new Error(wslDistroHoldMessage(wslDistro, state))
  }
}
