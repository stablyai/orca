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

describe('a result posted away from the thread its automation was made in', () => {
  it('starts with a line naming the automation and that thread', async () => {
    const posts: unknown[] = []
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial fixture; the code under test reads only these fields
    const deps = {
      cloudSignedOut: () => false,
      turnForOf: async () => 'owner',
      postAsBot: (_bot: unknown, body: unknown) => {
        posts.push(body)
        return Promise.resolve({ ok: true, value: undefined })
      }
    } as unknown as BotRunDeliveryDependencies
    const bot = {
      botId: 'b1',
      runsIn: 'chat',
      resultsTo: { channel: 'C9' },
      originThread: { source: 'slack', externalId: 'T1:C1:1.2', place: '#design' }
    } as const
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial fixture; the code under test reads only these fields
    await deliverBotRunResult(deps, {
      automation: { id: 'a1', name: 'Weekly recap', dtstart: 1, bot },
      run: { id: 'r1', trigger: 'scheduled' },
      bot: { id: 'b1', name: 'Ranger' },
      target: { runsIn: 'chat', resultsTo: bot.resultsTo },
      sessionId: 'run-chat',
      ended: { outcome: 'success', message: 'All green.' }
    } as unknown as BotRunResult)
    expect(posts).toEqual([
      {
        postId: 'r1',
        channelId: 'C9',
        turnFor: 'owner',
        text: '_From the automation “Weekly recap”, set up in the Slack thread in #design._\n\nAll green.'
      }
    ])
  })
})
