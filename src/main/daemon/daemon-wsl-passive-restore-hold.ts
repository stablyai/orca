import { readWslDistroRunningState } from '../wsl-background-distro-gate'
import { wslDistroHoldMessage } from '../../shared/wsl-distro-stopped-hold'
import type { PtySpawnOptions } from '../providers/pty-provider-contract'

/**
 * Launch restore, a reload or a remount the user did not ask for would start a stopped distro's
 * `wsl.exe` (E9). It starts only when a settled read proves the distro running; a stopped or
 * unanswered read holds the pane until the user's Start.
 */
export async function holdPassiveRestoreOfStoppedWslDistro(
  opts: Pick<PtySpawnOptions, 'wslPassiveRestore' | 'sessionId' | 'isNewSession' | 'attachOnly'>,
  wslDistro: string | undefined
): Promise<void> {
  if (
    opts.wslPassiveRestore !== true ||
    !wslDistro ||
    !opts.sessionId ||
    opts.isNewSession === true ||
    opts.attachOnly === true
  ) {
    return
  }
  const state = await readWslDistroRunningState(wslDistro, { retryUnverifiable: true })
  if (state !== 'running') {
    throw new Error(wslDistroHoldMessage(wslDistro, state))
  }
}
