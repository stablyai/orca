import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import type { ReplacedPaneOwner } from '../pane/replaced-pane-owner'
import type { PtyIpcSpawnState } from './spawn-state'

/** Keep dead bindings until one replacement write; the reservation excludes competing spawns. SSH owners still retire on their host. */
export function keepAbsentBindingForSwap(
  ctx: PtyIpcSpawnState
): ((dead: ReplacedPaneOwner) => void) | undefined {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN || ctx.replacedPaneOwner || ctx.args.connectionId) {
    return undefined
  }
  return (dead) => {
    ctx.replacedPaneOwner = dead
  }
}
