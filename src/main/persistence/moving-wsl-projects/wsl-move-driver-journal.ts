/**
 * The driver's first durable step: export the slept scope and journal it as `prepared`. Nothing has
 * reached the host yet, so every failure here is a refusal with its reason, never a put-back.
 */
import type { WslMoveRefusal } from '../../../shared/wsl-move/wsl-move-driver-types'
import type { WslMoveCutover } from '../../../shared/wsl-move/wsl-move-cutover'
import { journalWslMove } from './wsl-move-delta-plan'
import type { WslMoveDriverDeps } from './wsl-move-driver-ports'
import {
  exportRequestOf,
  isWslMoveScopeChanged,
  manifestTooLargeRefusal,
  refusal,
  type WslMovePrepared
} from './wsl-move-driver-plan'
import { resetWslMoveToZero } from './wsl-move-reset'
import { daemonHistoryLeafOf, type WslMoveSleptScrollback } from './wsl-move-slept-scrollback'

export async function journalSleptWslMove(
  deps: Pick<WslMoveDriverDeps, 'exportManifest' | 'userDataPath'>,
  prepared: WslMovePrepared,
  migrationId: string,
  startedAt: Date,
  slept: WslMoveSleptScrollback
): Promise<WslMoveCutover | WslMoveRefusal> {
  if (slept.problems.length > 0) {
    return refusal('wsl_move_export_incomplete', { reasons: [...slept.problems] })
  }
  try {
    // The slept state, which the session freeze then holds for the rest of the move.
    const exported = deps.exportManifest(
      exportRequestOf(prepared, migrationId, startedAt, daemonHistoryLeafOf(slept))
    )
    if (exported.blockers.length > 0) {
      return refusal('wsl_move_export_incomplete', { reasons: [...exported.blockers] })
    }
    return journalWslMove({
      userDataPath: deps.userDataPath,
      plan: prepared.plan,
      manifest: exported.manifest,
      destinationName: prepared.host.name,
      automationsToReenable: exported.automationsToReenable,
      now: () => startedAt
    })
  } catch (error) {
    // A write that landed before it threw would leave a record no host ever saw: drop it.
    await resetWslMoveToZero(
      { userDataPath: deps.userDataPath, destination: null },
      migrationId
    ).catch(() => {})
    const tooLarge = manifestTooLargeRefusal(error)
    if (tooLarge) {
      return tooLarge
    }
    const message = error instanceof Error ? error.message : String(error)
    if (message === 'wsl_move_already_in_flight') {
      return refusal('wsl_move_already_in_flight')
    }
    if (isWslMoveScopeChanged(error)) {
      return refusal('wsl_move_scope_changed')
    }
    console.warn('[wsl-move] Could not prepare the move:', error)
    return refusal('wsl_move_export_incomplete', {
      reasons: [`Orca could not prepare these projects' saved state (${message}).`]
    })
  }
}
