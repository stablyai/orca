import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SetOptionParams } from '../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-params'
import {
  createQueuedMessageTestRig,
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from '../host/testing/structured-agent-session-queued-message-rig.test-fixture'
import { eventually } from '../host/testing/structured-agent-session-queued-message-rig-provider.test-fixture'
import {
  hostTestCatalogReadOperation,
  HOST_TEST_SESSION as SESSION,
  hostTestOperationId
} from '../host/testing/structured-agent-session-host-test-data.test-fixture'
import { openRigTurnFor } from '../host/testing/structured-agent-session-queued-rig-turn.test-fixture'
import { createTestParams } from '../host/testing/structured-agent-session-create.test-fixture'

let rig: QueuedMessageTestRig
beforeEach(async () => {
  rig = await createQueuedMessageTestRig({ restartable: true })
})
afterEach(() => rig.dispose())

function pick(key: string, value: string | null, sessionId = SESSION) {
  const fields = { key, value }
  return rig.host.setOption(QUEUED_RIG_CALLER, {
    envelope: rig.envelope(fields, 'agentSession.setOption', hostTestOperationId(), sessionId),
    ...fields
  })
}

async function unstartedChat(sessionId: string) {
  const created = await rig.host.create(
    QUEUED_RIG_CALLER,
    createTestParams(undefined, {
      options: { model: 'picked-model' },
      envelope: {
        sessionId,
        clientOperationId: hostTestOperationId(),
        expectedRuntimeFence: null,
        payloadFingerprint: '0'.repeat(64)
      }
    })
  )
  expect(created).toMatchObject({ ok: true })
  return sessionId
}

/** A listing that names the agent's configured model only when `namesConfigured`. */
function catalog(namesConfigured: boolean) {
  const read = vi.fn(async () => ({
    origin: 'probe' as const,
    fetchedAt: 1,
    listingNamesConfiguredModel: namesConfigured,
    models: [{ id: 'configured-model', label: 'Configured', isDefault: true, efforts: [] }]
  }))
  rig.host.deps.modelCatalog = {
    captureRead: hostTestCatalogReadOperation,
    snapshot: () => ({ origin: 'unknown', models: [] }),
    demand: async () => {},
    prepareSaved: read,
    captureSource: () => () => true,
    retireContext: () => {},
    read,
    peek: () => null,
    recordLiveListing: () => {},
    prewarm: async () => {},
    stop: () => {},
    providerStarted: () => {}
  }
}

it('lets a chat that never ran launch without the remembered model', async () => {
  const sessionId = await unstartedChat('fresh-chat')
  expect(await pick('model', null, sessionId)).toMatchObject({
    ok: true,
    value: { value: null, modelDefault: true }
  })
  expect(rig.store.getRecord(sessionId)).toMatchObject({ options: {}, defaultModelOptions: {} })
  const { current } = await rig.host.readOptions(sessionId)
  expect(current.modelDefault).toBe(true)
  expect(current.acceptedInputSources?.model).toBeUndefined()
})

it('keeps the model a Default chat first ran on as its default, never as a pick', async () => {
  const sessionId = await unstartedChat('learning-chat')
  await pick('model', null, sessionId)
  const fence = rig.store.getRecord(sessionId)?.lease.runtimeFence ?? 1
  const ran = (model: string) =>
    rig.store.updateRecord(sessionId, {
      kind: 'ran-options',
      args: { sessionId, fence, now: 1, model, options: { model, effort: 'medium' }, models: [] }
    })
  await ran('configured-model')
  await ran('later-model')
  expect(rig.store.getRecord(sessionId)).toMatchObject({
    options: {},
    defaultModelOptions: { model: 'configured-model', effort: 'medium' }
  })
})

it("moves a chat that ran to the agent's configured model for its next message", async () => {
  const first = await rig.workingSend({ model: 'picked-model' })
  await rig.settleAccepted(first, 'first')
  await openRigTurnFor(rig, first)
  catalog(true)
  expect(await pick('model', null)).toMatchObject({
    ok: true,
    value: { modelDefault: true, options: { model: 'configured-model' } }
  })
  await rig.send('after reset', 'queue-if-active').result
  await openRigTurnFor(rig, first, 'interrupted')
  await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(2))
  expect(rig.dispatch.mock.calls[1]?.[0].executionOptions).toMatchObject({
    model: 'configured-model'
  })
  expect(rig.store.getRecord(SESSION)?.options?.model).toBeUndefined()
})

it("refuses a chat that ran when the host can't name the configured model", async () => {
  await rig.workingSend({ model: 'picked-model' })
  catalog(false)
  expect(await pick('model', null)).toMatchObject({ ok: false })
  expect(rig.store.getRecord(SESSION)?.defaultModelOptions).toBeUndefined()
})

it('stays on Default through an effort pick and leaves it on a model pick', async () => {
  catalog(true)
  await pick('model', null)
  await pick('effort', 'high')
  expect(rig.store.getRecord(SESSION)).toMatchObject({
    options: { effort: 'high' },
    defaultModelOptions: { model: 'configured-model' }
  })
  expect(await pick('model', 'another-model')).toMatchObject({ ok: true })
  const record = rig.store.getRecord(SESSION)
  expect(record?.defaultModelOptions).toBeUndefined()
  expect(record?.options).toMatchObject({ model: 'another-model', effort: 'high' })
})

it('takes null only for the model', () => {
  const envelope = rig.envelope({}, 'agentSession.setOption', hostTestOperationId())
  expect(SetOptionParams.safeParse({ envelope, key: 'model', value: null }).success).toBe(true)
  expect(SetOptionParams.safeParse({ envelope, key: 'effort', value: null }).success).toBe(false)
})
