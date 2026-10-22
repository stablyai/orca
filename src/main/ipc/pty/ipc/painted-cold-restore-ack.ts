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

/**
 * A view painted a cold restore: drop the terminal service's in-memory copy (checkpoint.json
 * keeps the history across restarts). No view, no ack.
 */
export function acknowledgePaintedColdRestore(
  args: Partial<PaintedRestoreAck> | null | undefined,
  isPaneBoundTo: ((pane: PaintedRestorePane, ptyId: string) => boolean) | undefined
): void {
  const id = args?.id
  if (typeof id !== 'string' || !id) {
    return
  }
  // Switch point: main releases it only for the pane's current terminal; a stale view's ack keeps it.
  if (ORCA_LAYOUT_OWNER_IS_MAIN && !(isPane(args?.pane) && isPaneBoundTo?.(args.pane, id))) {
    return
  }
  const provider = tryGetProviderForPty(id)
  if (provider && 'ackColdRestore' in provider && typeof provider.ackColdRestore === 'function') {
    provider.ackColdRestore(id)
  }
}
