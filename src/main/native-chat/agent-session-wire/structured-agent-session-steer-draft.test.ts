import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  hostTestMessage,
  hostTestOperationId,
  HOST_TEST_SESSION as SESSION
} from './structured-agent-session-host-test-data'
import { openRigTurnFor } from './structured-agent-session-queued-rig-turn.test-fixture'

let rig: QueuedMessageTestRig
beforeEach(async () => {
  rig = await createQueuedMessageTestRig({ restartable: true })
})
afterEach(() => rig.dispose())

it('steers the complete draft once with running choices while future picks and queued snapshots stay intact', async () => {
  const runningChoices = { model: 'model-a', effort: 'high', serviceTier: 'default' }
  rig.host.deps.adapter.readAppliedInputOptions = ({ next }) => ({
    active: runningChoices,
    next: next ?? {}
  })
  const first = rig.send('running', undefined, { carried: runningChoices })
  await first.result
  await eventually(() => expect(rig.dispatch).toHaveBeenCalledOnce())
  await rig.settleAccepted(first.id, 'running')
  await openRigTurnFor(rig, first.id)
  const queuedChoices = { model: 'model-c', effort: 'medium' }
  const queued = await rig.send('keep these choices', 'queue-if-active', { carried: queuedChoices })
    .result
  if (!queued.ok || !('queued' in queued.value)) {
    throw new Error('expected queued message')
  }
  const futureChoices = { model: 'model-b', effort: 'low', serviceTier: 'priority' }
  for (const [key, value] of Object.entries(futureChoices)) {
    const fields = { key, value }
    expect(
      await rig.host.setOption(QUEUED_RIG_CALLER, {
        envelope: rig.envelope(fields, 'agentSession.setOption', hostTestOperationId()),
        ...fields
      })
    ).toMatchObject({ ok: true })
  }
  const body = hostTestMessage('steer this same draft')
  body.blocks.push({ type: 'image-ref', path: '/tmp/steer.png' })
  const fields = { body, options: futureChoices, steer: true as const }
  const operationId = hostTestOperationId()
  const params = {
    envelope: rig.envelope(fields, 'agentSession.send', operationId),
    ...fields,
    userSend: true as const
  }
  expect(await rig.host.send(QUEUED_RIG_CALLER, params)).toMatchObject({ ok: true })
  await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(2))
  expect(rig.dispatch.mock.calls[1]?.[0]).toMatchObject({ body, executionOptions: runningChoices })
  expect((await rig.submission(operationId))?.options).toEqual(runningChoices)
  const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)?.journal
  expect(journal?.queuedMessages.get(queued.value.queued.messageId)?.options).toMatchObject(
    queuedChoices
  )
  expect(rig.store.getRecord(SESSION)?.options).toMatchObject(futureChoices)
  expect(await rig.host.send(QUEUED_RIG_CALLER, params)).toMatchObject({ ok: true, replayed: true })
  expect(rig.dispatch).toHaveBeenCalledTimes(2)
  expect(rig.setOption).not.toHaveBeenCalled()
})

it('uses future choices for a steer draft accepted with no running turn', async () => {
  const body = hostTestMessage('start a turn')
  const fields = { body, options: { model: 'model-b', effort: 'low' }, steer: true as const }
  expect(
    await rig.host.send(QUEUED_RIG_CALLER, {
      envelope: rig.envelope(fields, 'agentSession.send', hostTestOperationId()),
      ...fields
    })
  ).toMatchObject({ ok: true })
  await eventually(() => expect(rig.dispatch).toHaveBeenCalledOnce())
  expect(rig.dispatch.mock.calls[0]?.[0].executionOptions).toEqual(fields.options)
})

it('reuses the opening submission choices before the provider publishes its running turn', async () => {
  const choices = { model: 'model-a', effort: 'high', serviceTier: 'default' }
  rig.host.deps.adapter.readAppliedInputOptions = ({ next }) => ({
    active: choices,
    next: next ?? {}
  })
  const first = rig.send('opening', undefined, { carried: choices })
  expect(await first.result).toMatchObject({ ok: true })
  await eventually(() => expect(rig.dispatch).toHaveBeenCalledOnce())
  const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)?.journal
  expect(journal?.newestTurn()).toBeNull()
  expect(rig.host.currentWork(SESSION)?.working()).toBe(true)
  const fields = {
    body: hostTestMessage('clarify the opening turn'),
    steer: true as const,
    options: { model: 'model-b', effort: 'low', serviceTier: 'priority' }
  }
  const operation = hostTestOperationId()
  const params = {
    envelope: rig.envelope(fields, 'agentSession.send', operation),
    ...fields,
    userSend: true as const
  }
  expect(await rig.host.send(QUEUED_RIG_CALLER, params)).toMatchObject({ ok: true })
  expect((await rig.submission(operation))?.options).toEqual(choices)
  await rig.settleAccepted(first.id, 'opening')
  await openRigTurnFor(rig, first.id)
  await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(2))
  expect(rig.dispatch.mock.calls[1]?.[0].executionOptions).toEqual(choices)
  expect(await rig.host.send(QUEUED_RIG_CALLER, params)).toMatchObject({ ok: true, replayed: true })
  expect(rig.dispatch).toHaveBeenCalledTimes(2)
})

it.each([{ fastMode: 'true' }, { serviceTier: 'priority' }] as const)(
  'keeps a future speed choice from changing a running turn: %j',
  async (changed) => {
    const choices = { model: 'model-a', effort: 'high', fastMode: 'false', serviceTier: 'default' }
    const first = rig.send('running', undefined, { carried: choices })
    await first.result
    await eventually(() => expect(rig.dispatch).toHaveBeenCalledOnce())
    await rig.settleAccepted(first.id, 'running')
    await openRigTurnFor(rig, first.id)
    const nextChoices = { ...choices, ...changed }
    await rig.send('next turn', undefined, { carried: nextChoices }).result
    expect(rig.dispatch).toHaveBeenCalledOnce()
    await openRigTurnFor(rig, first.id, 'interrupted')
    await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(2))
    expect(rig.dispatch.mock.calls[1]?.[0].executionOptions).toEqual(nextChoices)
  }
)
