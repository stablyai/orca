import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/workspace-layout/layout-owner-switch'
import type { ReplacedPaneOwner } from '../pane/replaced-pane-owner'

type AbsentBindingSwapState = {
  replacedPaneOwner?: ReplacedPaneOwner | null
  args: { connectionId?: string | null }
}

/** Keep dead bindings until one replacement write; the reservation excludes competing spawns. SSH owners still retire on their host. */
export function keepsAbsentBindingForSwap(ctx: AbsentBindingSwapState): boolean {
  return ORCA_LAYOUT_OWNER_IS_MAIN && !ctx.replacedPaneOwner && !ctx.args.connectionId
}
