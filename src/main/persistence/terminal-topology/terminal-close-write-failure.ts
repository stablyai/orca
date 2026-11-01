// Keep applied closes after failed saves and retry persistence; frozen writes still refuse before mutation.

import type { LayoutCommand } from '../../../shared/workspace-layout/workspace-layout-command-types'
import type { DurableProfileStateMutation } from '../loading-store/store-runtime-state'

export function isTerminalClose(command: LayoutCommand): boolean {
  return command.type === 'closeTabs' || command.type === 'closePane'
}

/** Omit rollback so failed persistence cannot reopen an applied close. */
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
