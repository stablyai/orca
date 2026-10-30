/** Which parked distros a trigger other than the user's may move again. */
import type { WslMoveOrchestratorState } from '../../../shared/wsl-move/wsl-move-orchestrator-types'

export function parkedMayStart(
  state: Extract<WslMoveOrchestratorState, { kind: 'parked' }>,
  newBuild: boolean,
  now: number
): boolean {
  switch (state.reason) {
    case 'not-now':
      return state.until !== undefined && now >= state.until
    // A new build may carry the fix for whatever kept failing, or the host's update.
    case 'attempts-exhausted':
    case 'host-update-required':
    case 'stuck':
      return newBuild
    case 'export-incomplete':
    case 'manifest-too-large':
    case 'declined':
    case 'removal-pending':
    case 'finish-pending':
      return false
  }
}
