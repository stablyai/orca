import { describe, expect, it } from 'vitest'
import type { AutomationRun } from '../../shared/automations/history/automation-run'
import { normalizeLoadedAutomationRuns } from '../persistence/loading-store/profile-loading/normalize-loaded-state-collections'
import type { PersistedState } from '../../shared/orca-profiles/persisted-state-types'
import { makeTestBot } from './bot.test-fixture'
import { botBackgroundStartOptions } from './bot-start-options'
import { matchesAutomationRunModelFingerprint } from '../../shared/automations/history/automation-run-model-failure'
import {
  deliverBotRunResult,
  type BotRunDeliveryDependencies,
  type BotRunResult
} from './bot-run-results'

const NOTICE =
  "This run's message was answered together with another message, so its result wasn't posted."

it('keeps the failed run’s agent and model in the run result', async () => {
  const bot = makeTestBot({ agent: 'claude' })
  const model = botBackgroundStartOptions(
    { agentLaunchChoices: { claude: { model: 'model-x' } } },
    bot
  ).model
  const completion = await deliverBotRunResult(
    {
      notify: () => {},
      noteToChat: async () => {},
      sendToChat: async () => {},
      postAsBot: () => null,
      cloudSignedOut: () => false,
      noteToRun: async () => {},
      replyInThread: () => null,
      turnForOf: async () => 'none'
    },
    {
      automation: { id: 'auto-1', name: 'Morning digest', dtstart: 1 },
      run: { id: 'run-1', trigger: 'scheduled' },
      bot,
      target: { runsIn: 'new', resultsTo: 'none' },
      sessionId: 'session-1',
      launchModel: model,
      ended: { outcome: 'failure', message: '', failure: { kind: 'modelUnavailable' } }
    }
  )

  expect(completion).toMatchObject({
    status: 'dispatch_failed',
    errorCode: 'agentModelUnavailable',
    errorParams: { agent: 'claude', model: 'model-x' }
  })
  expect(
    matchesAutomationRunModelFingerprint(
      'model-x',
      'errorParams' in completion ? completion.errorParams : undefined
    )
  ).toBe(true)
})

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
