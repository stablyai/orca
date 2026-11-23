import { describe, expect, it } from 'vitest'
import type { AutomationRun } from '../../shared/automations/history/automation-run'
import { normalizeLoadedAutomationRuns } from '../persistence/loading-store/profile-loading/normalize-loaded-state-collections'
import type { PersistedState } from '../../shared/orca-profiles/persisted-state-types'
import {
  deliverBotRunResult,
  type BotRunDeliveryDependencies,
  type BotRunResult
} from './bot-run-results'

const NOTICE =
  "This run's message was answered together with another message, so its result wasn't posted."

describe('a run answered together with another message', () => {
  it('completes: its prompt was handled in the turn that answered it', async () => {
    const completion = await deliverBotRunResult(
      {} as BotRunDeliveryDependencies,
      {
        ended: { unavailable: 'shared' }
      } as BotRunResult
    )
    expect(completion).toEqual({ status: 'completed', outputSnapshot: null, error: NOTICE })
  })

  it('reads as completed when an older build stored it as failed', () => {
    const run = {
      id: 'r1',
      automationId: 'a1',
      runNumber: 25,
      status: 'dispatch_failed',
      error: NOTICE,
      createdAt: 1,
      scheduledFor: 1
    } as AutomationRun
    const other = { ...run, id: 'r2', runNumber: 26, error: 'Could not start.' }
    let saved = false
    const runs = normalizeLoadedAutomationRuns(
      { automationRuns: [run, other] } as PersistedState,
      () => (saved = true)
    )
    expect(runs.map((r) => r.status)).toEqual(['completed', 'dispatch_failed'])
    expect(saved).toBe(true)
  })
})
