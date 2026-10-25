import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestOperationId
} from './structured-agent-session-host-test-data'

let rig: QueuedMessageTestRig

beforeEach(async () => {
  rig = await createQueuedMessageTestRig({
    restartable: true,
    reportsModel: 'gpt-ran',
    reportsEffort: 'high'
  })
})

afterEach(() => rig.dispose())

/** Codex goal turns have no ordinary Orca submission as their opener. */
async function startGoalTurn(
  firstChoices?: Readonly<Record<string, string>>,
  beforeGoal?: () => Promise<void>
): Promise<void> {
  const first = await rig.workingSend(firstChoices)
  await rig.settleAccepted(first, 'first')
  await beforeGoal?.()
  rig.host.deps.adapter.changeThreadGoal = vi.fn(async () => ({ ok: true as const }))
  const change = { kind: 'set' as const, objective: 'Keep improving the project' }
  expect(
    await rig.host.changeThreadGoal(QUEUED_RIG_CALLER, {
      envelope: rig.envelope({ change }, 'agentSession.threadGoal', hostTestOperationId()),
      change
    })
  ).toMatchObject({ ok: true })
  rig.providerEvents().appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'goal-turn', ordinal: 99 },
    {
      kind: 'turn',
      turnId: 'goal-turn',
      state: 'running',
      userItemId: `codex:${THREAD}:goal-turn:0`
    },
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await rig.host.flushStreamedEvents(SESSION)
}

it.each<{ label: string; choices: Readonly<Record<string, string>> }>([
  { label: 'matching', choices: { model: 'gpt-ran', effort: 'high' } },
  { label: 'inherited', choices: {} },
  { label: 'partly inherited', choices: { model: 'gpt-ran' } }
])('delivers $label choices while the goal turn is still running', async ({ choices }) => {
  await startGoalTurn()
  const steering = rig.send('Include the idle machine too', undefined, { carried: choices })
  expect(await steering.result).toMatchObject({ ok: true })
  await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(2))
  expect((await rig.submission(steering.id))?.handedOverAt).toBeDefined()
  expect(rig.host.currentWork(SESSION)?.working()).toBe(true)
  expect(
    rig.host.collaboratorsForTests().sessions.get(SESSION)?.journal.newestTurn()
  ).toMatchObject({ turnId: 'goal-turn', state: 'running' })
  expect(rig.cancelTurn).not.toHaveBeenCalled()
})

it.each([
  { label: 'model', choices: { model: 'other-model', effort: 'high' } },
  { label: 'effort', choices: { model: 'gpt-ran', effort: 'low' } }
])('holds a different $label until the goal turn ends', async ({ choices }) => {
  await startGoalTurn()
  const steering = rig.send('Use different choices', undefined, { carried: choices })
  expect(await steering.result).toMatchObject({ ok: true })
  await rig.host.collaboratorsForTests().conversationDelivery.loop.wake(SESSION)
  expect(rig.dispatch).toHaveBeenCalledOnce()
  expect((await rig.submission(steering.id))?.handedOverAt).toBeUndefined()
  rig
    .providerEvents()
    .appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'goal-turn', ordinal: 99 },
      { kind: 'turn', turnId: 'goal-turn', state: 'completed' },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  await rig.host.flushStreamedEvents(SESSION)
  await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(2))
  expect(rig.dispatch.mock.calls[1]?.[0].executionOptions).toEqual(choices)
})

it('steers inherited choices without inventing an unreported model', async () => {
  await rig.dispose()
  rig = await createQueuedMessageTestRig({ restartable: true })
  await startGoalTurn()
  const steering = rig.send('Keep going with the current choices')
  expect(await steering.result).toMatchObject({ ok: true })
  await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(2))
  expect(rig.dispatch.mock.calls[1]?.[0].executionOptions).toEqual({})
  expect(rig.store.getRecord(SESSION)?.options).toBeUndefined()
})

it('does not assume an explicit choice matches when the child has not reported it', async () => {
  await rig.dispose()
  rig = await createQueuedMessageTestRig({ restartable: true })
  await startGoalTurn()
  const steering = rig.send('Use a specific model', undefined, {
    carried: { model: 'gpt-ran' }
  })
  expect(await steering.result).toMatchObject({ ok: true })
  await rig.host.collaboratorsForTests().conversationDelivery.loop.wake(SESSION)
  expect(rig.dispatch).toHaveBeenCalledOnce()
  expect((await rig.submission(steering.id))?.handedOverAt).toBeUndefined()
})

it.each([
  { label: 'steers the overriding choices', choices: { model: 'other-model' }, dispatches: 2 },
  { label: 'holds the reported model', choices: { model: 'gpt-ran' }, dispatches: 1 }
])(
  'compares with the last turn/start override the goal inherits: $label',
  async ({ choices, dispatches }) => {
    await startGoalTurn({ model: 'other-model', effort: 'high' })
    const steering = rig.send('Follow up', undefined, { carried: { ...choices, effort: 'high' } })
    expect(await steering.result).toMatchObject({ ok: true })
    await rig.host.collaboratorsForTests().conversationDelivery.loop.wake(SESSION)
    expect(rig.dispatch).toHaveBeenCalledTimes(dispatches)
  }
)

it('compares with a send that set the thread choices before its turn rejected it', async () => {
  await startGoalTurn(undefined, async () => {
    const stopped = await rig.workingSend({ model: 'other-model', effort: 'high' })
    await rig.host.settleLateDispatch({
      sessionId: SESSION,
      clientMessageId: stopped,
      state: 'rejected',
      ...agentSessionFailureWords(agentSessionFailureFact('cancelled'), { surface: 'rejection' }),
      answeredInTurn: {
        turn: { provider: 'codex', threadId: THREAD, turnId: 'turn-stopped', ordinal: 0 },
        via: 'start'
      }
    })
  })
  const steering = rig.send('Back to the reported model', undefined, {
    carried: { model: 'gpt-ran', effort: 'high' }
  })
  expect(await steering.result).toMatchObject({ ok: true })
  await rig.host.collaboratorsForTests().conversationDelivery.loop.wake(SESSION)
  expect(rig.dispatch).toHaveBeenCalledTimes(2)
})
