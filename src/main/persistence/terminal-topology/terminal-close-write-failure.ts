// A terminal close in a layout-owner build matches what the switch-off window shows: the tab or
// pane is gone once closed. A failed profile write (unwritable profile, full disk) is logged and
// written again later, never refused, so main's frame does not bring the tab back. A freeze
// (`writesFrozen`, a WSL move) refuses before the close changes anything.

import type { LayoutCommand } from '../../../shared/workspace-layout/workspace-layout-command-types'
import type { DurableProfileStateMutation } from '../loading-store/store-runtime-state'

export function isTerminalClose(command: LayoutCommand): boolean {
  return command.type === 'closeTabs' || command.type === 'closePane'
}

/** Runs `mutate` without its rollback: once applied, the close stands even if its write fails. */
export async function keptOnWriteFailure<V>(
  run: (mutate: () => DurableProfileStateMutation<V>) => Promise<V>,
  mutate: () => DurableProfileStateMutation<V>,
  writeLater: () => void
): Promise<V> {
  const applied: { current: { value: V } | null } = { current: null }
  try {
    return await run(() => {
      const { rollback: _rollback, ...mutation } = mutate()
      applied.current = { value: mutation.value }
      return mutation
    })
  } catch (error) {
    const kept = applied.current
    if (!kept) {
      throw error
    }
    console.warn(
      '[layout] a terminal close is applied but not yet saved; saving again later:',
      error
    )
    writeLater()
    return kept.value
  }
}
