import { afterEach, beforeEach, expect, it } from 'vitest'
import { providerDiagnostic, withProviderDiagnostic } from '../../../shared/agent-session-failure'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestOperationId,
  HOST_TEST_THREAD as THREAD
} from './structured-agent-session-host-test-data'
import { AgentSessionOptionRejectedError } from './structured-agent-session-option-error'

let rig: QueuedMessageTestRig

beforeEach(async () => {
  rig = await createQueuedMessageTestRig({ restartable: true })
})

afterEach(() => rig.dispose())

async function pickModel(model: string): Promise<void> {
  const fields = { key: 'model', value: model }
  const result = await rig.host.setOption(QUEUED_RIG_CALLER, {
    envelope: rig.envelope(fields, 'agentSession.setOption', hostTestOperationId()),
    ...fields
  })
  expect(result).toMatchObject({ ok: true })
}

it('keeps the first accepted choice through opening and saves a later pick for the next send', async () => {
  await rig.dispose()
  rig = await createQueuedMessageTestRig({ starting: true, restartable: true })
  const first = rig.send('first', undefined, { carried: { model: 'model-a' } })
  expect(await first.result).toMatchObject({ ok: true })
  await pickModel('model-b')
  const second = rig.send('second')
  expect(await second.result).toMatchObject({ ok: true })
  expect(rig.setOption).not.toHaveBeenCalled()
  await rig.proveStart()
  await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(1))
  expect(rig.dispatch.mock.calls[0]?.[0].executionOptions).toEqual({ model: 'model-a' })
  await rig.settleAccepted(first.id, 'a')
  await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(2))
  expect(rig.dispatch.mock.calls[1]?.[0].executionOptions).toEqual({ model: 'model-b' })
  expect(rig.store.getRecord(SESSION)?.options?.model).toBe('model-b')
})

it('keeps the model and effort a chat with none saved first ran, after its config moves', async () => {
  await rig.dispose()
  const agent = { restartable: true as const, reportsModel: 'gpt-ran', reportsEffort: 'xhigh' }
  rig = await createQueuedMessageTestRig(agent)
  const first = rig.send('first')
  expect(await first.result).toMatchObject({ ok: true })
  await eventually(() =>
    expect(rig.store.getRecord(SESSION)?.options).toEqual({ model: 'gpt-ran', effort: 'xhigh' })
  )
  await rig.settleAccepted(first.id, 'a')
  Object.assign(agent, { reportsModel: 'gpt-new', reportsEffort: 'low' })
  await rig.restartHostProcess()
  const second = rig.send('second')
  expect(await second.result).toMatchObject({ ok: true })
  await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(2))
  expect(rig.dispatch.mock.calls[1]?.[0].executionOptions).toEqual({
    model: 'gpt-ran',
    effort: 'xhigh'
  })
})

it('records what a later readback reports when the start named only a filled-in default', async () => {
  // As Claude's start: no model yet, then its settings readback names the one the turn runs.
  const first = rig.send('first')
  expect(await first.result).toMatchObject({ ok: true })
  await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(1))
  expect(rig.store.getRecord(SESSION)?.options).toBeUndefined()
  await rig.host.handleAdapterEvent({
    type: 'options-reported',
    sessionId: SESSION,
    fence: rig.store.getRecord(SESSION)!.lease.runtimeFence,
    acquisitionGeneration: 'generation-1',
    reportedOptions: { model: 'opus[1m]', effort: 'high' }
  })
  await eventually(() =>
    expect(rig.store.getRecord(SESSION)?.options).toEqual({ model: 'opus[1m]', effort: 'high' })
  )
})

it('rejects a refused choice before prompt input and leaves the next pick saved', async () => {
  await pickModel('model-b')
  rig.dispatch.mockRejectedValueOnce(
    withProviderDiagnostic(
      new AgentSessionOptionRejectedError('model-a is unavailable'),
      providerDiagnostic('model-a is unavailable', 'person')
    )
  )
  const first = rig.send('first', undefined, { carried: { model: 'model-a' } })
  expect(await first.result).toMatchObject({ ok: true })
  await eventually(async () =>
    expect(await rig.submission(first.id)).toMatchObject({
      dispatchState: 'rejected',
      reason: expect.stringContaining('model-a is unavailable')
    })
  )
  expect(rig.dispatch).toHaveBeenCalledOnce()
  expect(rig.store.getRecord(SESSION)?.options?.model).toBe('model-b')
})

it('uses each send’s captured choices when two messages arrive during startup', async () => {
  const releaseStart = rig.holdNextStart()
  const first = rig.send('first', undefined, {
    carried: { model: 'model-a', effort: 'high' }
  })
  const second = rig.send('second', undefined, {
    carried: { model: 'model-b', effort: 'low' }
  })
  expect(await first.result).toMatchObject({ ok: true })
  expect(await second.result).toMatchObject({ ok: true })
  expect(rig.dispatch).not.toHaveBeenCalled()
  releaseStart()
  await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(1))
  await rig.settleAccepted(first.id, 'a')
  await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(2))
  expect(rig.dispatch.mock.calls.map(([input]) => input.executionOptions)).toEqual([
    { model: 'model-a', effort: 'high' },
    { model: 'model-b', effort: 'low' }
  ])
  expect(rig.setOption).not.toHaveBeenCalled()
})

it('keeps a draft’s accepted choices through a host restart and Send now', async () => {
  const working = await rig.workingSend()
  const choices = { model: 'model-b', effort: 'low' }
  const queued = await rig.send('use these choices', 'queue-if-active', {
    carried: choices
  }).result
  if (!queued.ok || !('queued' in queued.value)) {
    throw new Error('expected a queued receipt')
  }
  const draftId = queued.value.queued.messageId
  await rig.restartHostProcess()
  expect(await rig.host.history({ sessionId: SESSION, direction: 'tail' })).toMatchObject({
    ok: true
  })
  const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)?.journal
  expect(journal?.queuedMessages.get(draftId)?.options).toEqual(choices)
  await rig.settleAccepted(working, 'a')
  expect(await rig.sendNow(draftId)).toMatchObject({ ok: true })
  expect((await rig.handoff(draftId))?.options).toEqual(choices)
})

it('steers a matching choice but holds a different one for a new turn', async () => {
  const choices = { model: 'model-a', effort: 'high' }
  const first = rig.send('first', undefined, { carried: choices })
  await first.result
  await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(1))
  await rig.settleAccepted(first.id, 'a')
  rig
    .providerEvents()
    .appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'turn-a', ordinal: 0 },
      { kind: 'turn', turnId: 'turn-a', state: 'running' },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  await rig.host.flushStreamedEvents(SESSION)

  const extras = { ...choices, personality: 'friendly', serviceTier: 'priority', fastMode: 'true' }
  const matching = rig.send('same choices', undefined, { carried: extras })

  await matching.result
  await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(2))
  expect(rig.dispatch.mock.calls[1]?.[0].executionOptions).toEqual(extras)
  await rig.host.settleLateDispatch({
    sessionId: SESSION,
    clientMessageId: matching.id,
    providerIdentity: { provider: 'codex', threadId: THREAD, turnId: 'turn-a', ordinal: 1 }
  })
  const other = rig.send('other choices', undefined, { carried: { effort: 'low' } })
  await other.result
  expect(rig.dispatch).toHaveBeenCalledTimes(2)

  rig
    .providerEvents()
    .appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'turn-a', ordinal: 0 },
      { kind: 'turn', turnId: 'turn-a', state: 'completed' },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  await rig.host.flushStreamedEvents(SESSION)
  await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(3))
  expect(rig.dispatch.mock.calls[2]?.[0].executionOptions).toEqual({
    model: 'model-a',
    effort: 'low'
  })
})
