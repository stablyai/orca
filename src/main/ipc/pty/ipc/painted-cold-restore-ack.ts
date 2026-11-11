import type { PaintedRestoreAck, PaintedRestorePane } from '../../../../shared/painted-restore-ack'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { tryGetProviderForPty } from '../provider/registry'

function isPane(value: unknown): value is PaintedRestorePane {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const pane: Partial<Record<keyof PaintedRestorePane, unknown>> = value
  return (
    typeof pane.worktreeId === 'string' &&
    typeof pane.tabId === 'string' &&
    typeof pane.leafId === 'string'
  )
}

/** Release in-memory cold restore only after painting; checkpoint.json retains restart history. */
export function acknowledgePaintedColdRestore(
  args: Partial<PaintedRestoreAck> | null | undefined,
  isPaneBoundTo: ((pane: PaintedRestorePane, ptyId: string) => boolean) | undefined
): void {
  const id = args?.id
  if (typeof id !== 'string' || !id) {
    return
  }
  // A stale view cannot release the current pane terminal's restore cache.
  if (ORCA_LAYOUT_OWNER_IS_MAIN && !(isPane(args?.pane) && isPaneBoundTo?.(args.pane, id))) {
    return
  }
  const provider = tryGetProviderForPty(id)
  if (provider && 'ackColdRestore' in provider && typeof provider.ackColdRestore === 'function') {
    provider.ackColdRestore(id)
  }
}
