import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import type { ReplacedPaneOwner } from '../pane/replaced-pane-owner'
import type { PtyIpcSpawnState } from './spawn-state'

/**
 * Switch point: a gone process's binding stays until this spawn's bind swaps it, one write, so the
 * pane is never published unbound. Stable-pane adoption holds the pane's reservation through its fresh
 * launch, which keeps any other spawn off the pane meanwhile.
 * A pane on an SSH host keeps the early retire: its dead owner lives on that host.
 */
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
