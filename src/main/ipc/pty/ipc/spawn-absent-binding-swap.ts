import type { ReplacedPaneOwner } from '../pane/replaced-pane-owner'
import type { PtySpawnOperationState } from '../spawn-operation-state'

/** Keep dead bindings until one replacement write; the reservation excludes competing spawns. SSH owners still retire on their host. */
export function keepAbsentBindingForSwap(
  ctx: Pick<PtySpawnOperationState, 'args' | 'replacedPaneOwner'>
): ((dead: ReplacedPaneOwner) => void) | undefined {
  if (ctx.replacedPaneOwner || ctx.args.connectionId) {
    return undefined
  }
  return (dead) => {
    ctx.replacedPaneOwner = dead
  }
}
