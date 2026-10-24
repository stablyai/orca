import type { WslMoveResult } from '../../../shared/wsl-move/wsl-move-driver-types'
import { listWslMoveCutovers } from './wsl-move-cutover-journal'
import type { WslMoveDriverDeps } from './wsl-move-driver-ports'
import { wslMoveAutomationsPending } from './wsl-move-host-automations-rewrite'
import { settleWslMoveWindowWriteHoldForCommit } from './wsl-move-window-write-hold'

/** A committed move's last step on this desktop, from the driver or a reset that found the commit. */
export async function finishWslMove(
  deps: WslMoveDriverDeps,
  distro: string,
  migrationId: string
): Promise<WslMoveResult> {
  deps.progress({ distro, step: 'finishing', migrationId, phase: 'destination-committed' })
  // Forward only from here: a failed rewrite resumes on the next pass or startup, never resets.
  await deps.finishOnDesktop().catch((error: unknown) => {
    console.warn('[wsl-move] Finishing the move on this desktop paused:', error)
  })
  // Even after a paused rewrite: the window the commit request held must not keep its stale page.
  settleWslMoveWindowWriteHoldForCommit(true)
  const cutover = listWslMoveCutovers(deps.userDataPath).find(
    (entry) => entry.migrationId === migrationId
  )
  const phase = cutover?.phase ?? 'destination-committed'
  // Never silently off: the result names them, and the rewrite pass keeps retrying them.
  const automationsPending = cutover ? wslMoveAutomationsPending(cutover) : []
  deps.progress({ distro, step: 'done', migrationId, phase })
  return {
    outcome: 'moved',
    migrationId,
    phase,
    reloadRequired: true,
    ...(automationsPending.length > 0 ? { automationsPending } : {})
  }
}
