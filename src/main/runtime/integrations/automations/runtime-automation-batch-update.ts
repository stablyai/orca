import type { AutomationUpdateInput } from '../../../../shared/automations/automation-definition'
import type {
  AutomationBatchUpdate,
  AutomationBatchUpdateResult
} from '../../../persistence/scheduling-automations/automation-definition-update'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import { RUNTIME_AUTOMATION_PATCH_KEYS } from './runtime-automation-patch-keys'
import type { RuntimeAutomationUpdateInput } from './runtime-automation-run-context'
import { hasRuntimeAutomationUpdateValue } from './runtime-automation-update-value'

export type RuntimeAutomationBatchUpdate = { id: string; updates: RuntimeAutomationUpdateInput }

// Why: these need the target or host checks only a single `update` performs.
const SINGLE_UPDATE_KEYS = [
  'repo',
  'workspace',
  'workspaceMode',
  'runContext',
  'reuseSession'
] as const satisfies readonly (keyof RuntimeAutomationUpdateInput)[]

/**
 * The controller's `update` for many automations at once: one store write and one flush instead
 * of one per row. Entries whose fields need target or host checks are refused, not partly applied.
 */
export async function updateRuntimeAutomations(
  store: RuntimeStore | null,
  entries: readonly RuntimeAutomationBatchUpdate[]
): Promise<AutomationBatchUpdateResult[]> {
  if (!store?.updateAutomations) {
    throw new Error('runtime_unavailable')
  }
  const batch: AutomationBatchUpdate[] = []
  const refused: AutomationBatchUpdateResult[] = []
  for (const { id, updates } of entries) {
    if (SINGLE_UPDATE_KEYS.some((key) => hasRuntimeAutomationUpdateValue(updates, key))) {
      refused.push({ id, error: new Error('This change needs a single automation update.') })
      continue
    }
    const patch: AutomationUpdateInput = {}
    for (const key of RUNTIME_AUTOMATION_PATCH_KEYS) {
      if (hasRuntimeAutomationUpdateValue(updates, key)) {
        Object.assign(patch, { [key]: updates[key] })
      }
    }
    batch.push({ id, updates: patch })
  }
  const results = batch.length > 0 ? store.updateAutomations(batch) : []
  if (results.some((result) => 'automation' in result)) {
    await store.flushPendingOrThrowAsync?.({ drainToStableGeneration: false })
  }
  return [...refused, ...results]
}
