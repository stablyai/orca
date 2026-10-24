// Record only target_removed refusals; stale caller fences should not add run-history rows.

import type { AutomationRun } from '../../shared/automations-types'
import {
  AUTOMATION_OWNER_CONFLICT_CODES,
  AutomationOwnerConflictError
} from '../../shared/automation-owner-conflict'

type RefusableAutomationService = {
  runNow: (automationId: string) => Promise<AutomationRun>
  recordRefusedRun: (automationId: string) => void | Promise<void>
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
      await input.service.recordRefusedRun(input.automationId)
    }
    throw error
  }
  return await input.service.runNow(input.automationId)
}
