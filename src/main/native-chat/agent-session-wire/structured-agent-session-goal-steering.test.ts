import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
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
async function startGoalTurn(): Promise<void> {
  const first = await rig.workingSend()
  await rig.settleAccepted(first, 'first')
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
  await rig.host.collaboratorsForTests().serialize(SESSION, async () => {})
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
  await rig.host.collaboratorsForTests().serialize(SESSION, async () => {})
  expect(rig.dispatch).toHaveBeenCalledOnce()
  expect((await rig.submission(steering.id))?.handedOverAt).toBeUndefined()
})
