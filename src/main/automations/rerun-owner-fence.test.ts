import { describe, expect, it, vi } from 'vitest'
import { runAutomationNowFenced } from './refused-manual-run'
import {
  AUTOMATION_OWNER_CONFLICT_CODES,
  AutomationOwnerConflictError
} from '../../shared/automation-owner-conflict'
import type { AutomationRun } from '../../shared/automations-types'

describe('historical rerun owner fence', () => {
  it('passes the historical selection through only after checking its owner', async () => {
    const fence = vi.fn()
    const service = {
      runNow: vi.fn<() => Promise<AutomationRun>>(),
      recordRefusedRun: vi.fn()
    }
    await runAutomationNowFenced({ fence, service, automationId: 'daily', sourceRunId: 'monday' })
    expect(fence).toHaveBeenCalledBefore(service.runNow)
    expect(service.runNow).toHaveBeenCalledWith('daily', 'monday')
  })

  it.each([
    AUTOMATION_OWNER_CONFLICT_CODES.targetRemoved,
    AUTOMATION_OWNER_CONFLICT_CODES.ownerChanged
  ])('rejects %s without dispatching or recording an unrelated run for today', async (code) => {
    const conflict = new AutomationOwnerConflictError(code)
    const service = {
      runNow: vi.fn<() => Promise<AutomationRun>>(),
      recordRefusedRun: vi.fn()
    }
    await expect(
      runAutomationNowFenced({
        fence: () => {
          throw conflict
        },
        service,
        automationId: 'daily',
        sourceRunId: 'monday'
      })
    ).rejects.toBe(conflict)
    expect(service.runNow).not.toHaveBeenCalled()
    expect(service.recordRefusedRun).not.toHaveBeenCalled()
  })
})
