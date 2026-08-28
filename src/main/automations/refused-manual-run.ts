/**
 * The execute fence, plus the run-history row a refused manual attempt leaves.
 *
 * doc:94 pairs "return the typed `target_removed` conflict" with "record a
 * skipped-run reason", and the scheduled path already does both. Without this
 * the same automation produces a row when a schedule refuses it and nothing at
 * all when the user asks by hand, so run history contradicts itself.
 *
 * Only `target_removed` records: it is the verdict that the record has no host
 * at all. `owner_changed` and `fencing_required` say the CALLER is stale, and a
 * client re-reading and retrying must not litter history on the way.
 */

import type { AutomationRun } from '../../shared/automations-types'
import {
  AUTOMATION_OWNER_CONFLICT_CODES,
  AutomationOwnerConflictError
} from '../../shared/automation-owner-conflict'

type RefusableAutomationService = {
  runNow: (automationId: string) => Promise<AutomationRun>
  recordRefusedRun: (automationId: string) => void
}

export async function runAutomationNowFenced(input: {
  fence: () => void
  service: RefusableAutomationService
  automationId: string
}): Promise<AutomationRun> {
  try {
    input.fence()
  } catch (error) {
    if (
      error instanceof AutomationOwnerConflictError &&
      error.code === AUTOMATION_OWNER_CONFLICT_CODES.targetRemoved
    ) {
      input.service.recordRefusedRun(input.automationId)
    }
    throw error
  }
  return await input.service.runNow(input.automationId)
}
