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
import {
  scanWslMoveCutovers,
  writeWslMoveCutover
} from '../cutover-recovery/wsl-move-cutover-journal'
import { runWslMoveHostAutomationsExclusive } from '../cutover-recovery/wsl-move-host-automations-lock'
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
  migrationId: string,
  afterDisable: (move: Readonly<WslMoveCutover>) => Promise<void> = async () => {}
): Promise<void> {
  return runWslMoveHostAutomationsExclusive(async () => {
    const move = scanWslMoveCutovers(userDataPath).find((c) => c.migrationId === migrationId)
    if (!move) {
      return
    }
    // Only the ones that were on here: the rest are already off, and undo reads them from the host.
    const ids = move.automationsToReenable ?? []
    if (ids.length > 0) {
      profile.disableAutomations(new Set(ids))
    }
    await afterDisable(move)
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

/** A move that left its rewrite phase before this store existed, with automations still to turn off. */
function finishedBeforeLocalAutomations(cutover: Readonly<WslMoveCutover>): boolean {
  return (
    WSL_MOVE_CUTOVER_PHASES.indexOf(cutover.phase) > COMMITTED &&
    !cutover.rewrittenStores.includes(WSL_MOVE_LOCAL_AUTOMATIONS_STORE_ID) &&
    !cutover.localAutomationsCaughtUp &&
    (cutover.automationsToReenable?.length ?? 0) > 0
  )
}

/** Startup's once-per-move catch-up, marked beside the closed ledger so a copy re-enabled by hand stays on. */
export async function disableLocalAutomationsOfEarlierWslMoves(
  userDataPath: string,
  profile: WslMoveLocalAutomationsProfile
): Promise<void> {
  const migrationIds = scanWslMoveCutovers(userDataPath)
    .filter(finishedBeforeLocalAutomations)
    .map((cutover) => cutover.migrationId)
  for (const migrationId of migrationIds) {
    try {
      await disableWhileMoved(userDataPath, profile, migrationId, async (move) => {
        // The disable is on disk before the mark: a crash between them only repeats it.
        await profile.flushPendingOrThrowAsync()
        writeWslMoveCutover(userDataPath, {
          ...move,
          localAutomationsCaughtUp: true,
          updatedAt: new Date().toISOString()
        })
      })
    } catch (error) {
      // One move's failure must not skip the rest; it is tried again next launch.
      console.warn(`[wsl-move] Could not turn off move ${migrationId}'s automations here:`, error)
    }
  }
}
