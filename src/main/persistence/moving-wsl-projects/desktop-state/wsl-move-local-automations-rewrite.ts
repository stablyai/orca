/**
 * After a WSL move commits, the copies here of the automations the host now runs turn off: the
 * scheduler skips them anyway, and an "on" copy beside the host's reads as a second live one.
 * Undo gives them the host's state back (wsl-move-undo-host-automations.ts).
 */
import {
  WSL_MOVE_CUTOVER_PHASES,
  type WslMoveCutover
} from '../../../../shared/wsl-move/wsl-move-cutover'
import type { Store } from '../../loading-store/store'
import { listWslMoveCutovers } from '../cutover-recovery/wsl-move-cutover-journal'
import { runWslMoveHostAutomationsExclusive } from '../cutover-recovery/wsl-move-undo-host-automations'
import { registerWslMoveDesktopRewriteStore } from './wsl-move-desktop-rewrite-stores'

export const WSL_MOVE_LOCAL_AUTOMATIONS_STORE_ID = 'local-automations'

export type WslMoveLocalAutomationsProfile = Pick<
  Store,
  'disableAutomations' | 'flushPendingOrThrowAsync'
>

/**
 * Off only while the move still stands, in undo's turn: an undo that released it meanwhile has
 * given these copies their state, which this must not overwrite.
 */
function disableWhileMoved(
  userDataPath: string,
  profile: WslMoveLocalAutomationsProfile,
  migrationId: string
): Promise<void> {
  return runWslMoveHostAutomationsExclusive(async () => {
    const move = listWslMoveCutovers(userDataPath).find((c) => c.migrationId === migrationId)
    // Only the ones that were on here: the rest are already off, and undo reads them from the host.
    const ids = move?.automationsToReenable ?? []
    if (ids.length > 0) {
      profile.disableAutomations(new Set(ids))
    }
  })
}

export function registerWslMoveLocalAutomationsStore(
  profile: WslMoveLocalAutomationsProfile,
  userDataPath: string
): void {
  registerWslMoveDesktopRewriteStore({
    id: WSL_MOVE_LOCAL_AUTOMATIONS_STORE_ID,
    side: 'main',
    run: ({ cutover }) => disableWhileMoved(userDataPath, profile, cutover.migrationId),
    flush: () => profile.flushPendingOrThrowAsync()
  })
}

const COMMITTED = WSL_MOVE_CUTOVER_PHASES.indexOf('destination-committed')

/** A move that left its rewrite phase before this store existed: its copies here are still on. */
function finishedBeforeLocalAutomations(cutover: WslMoveCutover): boolean {
  return (
    WSL_MOVE_CUTOVER_PHASES.indexOf(cutover.phase) > COMMITTED &&
    !cutover.rewrittenStores.includes(WSL_MOVE_LOCAL_AUTOMATIONS_STORE_ID)
  )
}

/**
 * Startup's one-time catch-up for those moves. Their ledger is closed, so nothing records it;
 * turning off what is already off changes nothing on the next launch.
 */
export async function disableLocalAutomationsOfEarlierWslMoves(
  userDataPath: string,
  profile: WslMoveLocalAutomationsProfile
): Promise<void> {
  for (const cutover of listWslMoveCutovers(userDataPath).filter(finishedBeforeLocalAutomations)) {
    await disableWhileMoved(userDataPath, profile, cutover.migrationId)
  }
}
