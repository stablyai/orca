import type { AutomationUpdateInput } from '../../../../shared/automations/automation-definition'
import type { AutomationBatchUpdateResult } from '../../../persistence/scheduling-automations/automation-definition-update'
import type { RuntimeStore } from '../../construction/runtime-store-contract'

/** Why only these fields: target, run-context and session changes need the checks only a single
 *  `update` performs, so the batch path cannot carry them. */
export type RuntimeAutomationBatchUpdate = {
  id: string
  updates: Pick<AutomationUpdateInput, 'enabled' | 'createdBy'>
}

/**
 * The controller's `update` for many automations at once: one store write and one flush instead
 * of one per row.
 */
export async function updateRuntimeAutomations(
  store: RuntimeStore | null,
  entries: readonly RuntimeAutomationBatchUpdate[]
): Promise<AutomationBatchUpdateResult[]> {
  if (!store?.updateAutomations) {
    throw new Error('runtime_unavailable')
  }
  if (entries.length === 0) {
    return []
  }
  const results = store.updateAutomations(
    entries.map(({ id, updates }) => ({
      id,
      updates: {
        ...(updates.enabled !== undefined ? { enabled: updates.enabled } : {}),
        ...(updates.createdBy !== undefined ? { createdBy: updates.createdBy } : {})
      }
    }))
  )
  if (results.some((result) => 'automation' in result)) {
    await store.flushPendingOrThrowAsync?.({ drainToStableGeneration: false })
  }
  return results
}
