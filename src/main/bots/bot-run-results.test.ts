import { describe, expect, it, vi } from 'vitest'
import type { AutomationRun } from '../../shared/automations/history/automation-run'
import { normalizeLoadedAutomationRuns } from '../persistence/loading-store/profile-loading/normalize-loaded-state-collections'
import type { PersistedState } from '../../shared/orca-profiles/persisted-state-types'
import {
  deliverBotRunResult,
  type BotRunDeliveryDependencies,
  type BotRunResult
} from './bot-run-results'
import { watchBotTurnEnds } from './bot-run-turn-watch'
import { agentJournalSubmissionKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'

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

describe('a run steered into a turn another message opened', () => {
  it('ends as that turn does: a failed turn leaves the run failed', async () => {
    const turn = { state: 'running', outcome: undefined as string | undefined }
    const journal = () => ({
      items: [
        {
          itemId: 'T',
          body: { kind: 'turn', ...turn, userItemId: agentJournalSubmissionKey('u') }
        },
        { itemId: agentJournalSubmissionKey('run'), turnScope: { kind: 'turn', turnItemId: 'T' } }
      ],
      submissions: [
        { clientMessageId: 'u', dispatchState: 'accepted', providerItemId: null },
        {
          clientMessageId: 'run',
          dispatchState: 'accepted',
          providerItemId: null,
          answeredInTurn: { turnItemId: 'T', via: 'steer' }
        }
      ]
    })
    let emit: (event: unknown) => void = () => {}
    let reads = 0
    const host = {
      subscribeTurnCompletions: (listener: { emit: typeof emit }) => {
        emit = listener.emit
        return () => {}
      },
      subscribe: async () => () => {},
      history: async () => ({ ok: false }),
      currentWork: async () => null,
      journalReads: async () => ({
        operationWindow: async () => {
          reads += 1
          return { snapshot: journal() }
        }
      })
    }
    const watch = watchBotTurnEnds(host as never)
    const ended = watch.next({ sessionId: 's', clientMessageId: 'run', fingerprint: 'f' })
    await vi.waitFor(() => expect(reads).toBe(1))
    Object.assign(turn, { state: 'completed', outcome: 'failure' })
    emit({ type: 'completion', completion: { sessionId: 's' } })
    const completion = await deliverBotRunResult(
      { notify: () => {} } as unknown as BotRunDeliveryDependencies,
      {
        ended: await ended,
        bot: { paused: true },
        automation: { name: 'a' },
        target: { runsIn: 'chat', resultsTo: 'none' }
      } as unknown as BotRunResult
    )
    expect(completion.status).toBe('dispatch_failed')
  })
})
