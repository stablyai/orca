import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SetOptionParams } from '../../../shared/rpc-contract/structured-agent-session-params'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  hostTestCatalogReadOperation,
  HOST_TEST_SESSION as SESSION,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import { openRigTurnFor } from './structured-agent-session-queued-rig-turn.test-fixture'
import { createTestParams } from './structured-agent-session-create-test-fixture'
import { recordAgentSessionRanOptions } from '../../runtime/agent-session-record-options'
import { effectiveAgentSessionOptions } from '../../../shared/agent-session-default-model'
import { optionSession } from '../../codex/codex-structured-option-session.test-fixture'
import { resolvedCodexMessageOptions } from '../../codex/codex-structured-message-options'

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
  expect(
    await rig.host.create(
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
  ).toMatchObject({ ok: true })
  return sessionId
}

function catalog(namesConfigured: boolean) {
  const read = vi.fn(async () => ({
    origin: 'probe' as const,
    fetchedAt: 1,
    listingNamesConfiguredModel: namesConfigured,
    ...(namesConfigured
      ? { defaultModelOptions: { model: 'configured-model', effort: 'medium' } }
      : {}),
    models: [
      {
        id: 'configured-model',
        label: 'Configured',
        isDefault: true,
        defaultEffort: 'medium',
        efforts: [{ value: 'medium', label: 'Medium' }]
      }
    ]
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
  return read
}

it('clears a new unstarted chat override without guessing its provider default', async () => {
  const sessionId = 'new-default-chat'
  expect(
    await rig.host.create(
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
  ).toMatchObject({ ok: true })
  expect(await pick('model', null, sessionId)).toMatchObject({
    ok: true,
    value: { modelDefault: true }
  })
  const record = rig.store.getRecord(sessionId)
  expect(record?.options?.model).toBeUndefined()
  expect(record?.defaultModelOptions).toEqual({})
  expect(rig.dispatch).not.toHaveBeenCalled()
})

it('learns an omitted new-chat default once from execution without restoring an explicit override', async () => {
  const sessionId = 'omitted-default-chat'
  await rig.host.create(
    QUEUED_RIG_CALLER,
    createTestParams(undefined, {
      envelope: {
        sessionId,
        clientOperationId: hostTestOperationId(),
        expectedRuntimeFence: null,
        payloadFingerprint: '0'.repeat(64)
      }
    })
  )
  expect(await pick('model', null, sessionId)).toMatchObject({ ok: true })
  const record = rig.store.getRecord(sessionId)
  if (!record) {
    throw new Error('expected the session')
  }
  const report = (model: string) =>
    rig.store.reviseSessionOptions(recordAgentSessionRanOptions, {
      sessionId,
      fence: record.lease.runtimeFence,
      now: 1_700_000_000_000,
      model,
      options: { model, effort: 'medium' },
      models: []
    })
  await report('original-executed-default')
  expect(rig.store.getRecord(sessionId)).toMatchObject({
    options: {},
    defaultModelOptions: { model: 'original-executed-default', effort: 'medium' }
  })
  await report('later-provider-model')
  expect(rig.store.getRecord(sessionId)?.defaultModelOptions?.model).toBe(
    'original-executed-default'
  )
  expect(rig.store.getRecord(sessionId)?.options?.model).toBeUndefined()
})

it('snapshots the original host default for future queued messages while preserving the running turn', async () => {
  const first = await rig.workingSend({ model: 'picked-model', effort: 'high' })
  await rig.settleAccepted(first, 'first')
  await openRigTurnFor(rig, first)
  const before = await rig.send('before reset', 'queue-if-active', {
    carried: { model: 'picked-model', effort: 'high' }
  }).result
  catalog(true)
  expect(await pick('model', null)).toMatchObject({ ok: true, value: { modelDefault: true } })
  const after = await rig.send('after reset', 'queue-if-active').result
  if (!before.ok || !('queued' in before.value) || !after.ok || !('queued' in after.value)) {
    throw new Error('expected queued drafts')
  }
  const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  expect(journal.queuedMessages.get(before.value.queued.messageId)?.options).toEqual({
    model: 'picked-model',
    effort: 'high'
  })
  expect(journal.queuedMessages.get(after.value.queued.messageId)?.options).toEqual({
    model: 'configured-model',
    effort: 'high'
  })
  expect((await rig.submission(first))?.options).toEqual({ model: 'picked-model', effort: 'high' })
  expect(rig.store.getRecord(SESSION)?.options?.model).toBeUndefined()
  expect(rig.dispatch).toHaveBeenCalledOnce()
  expect(rig.setOption).not.toHaveBeenCalled()
  await rig.deleteQueued(before.value.queued.messageId)
  await openRigTurnFor(rig, first, 'interrupted')
  await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(2))
  expect(rig.dispatch.mock.calls[1]?.[0].executionOptions).toEqual({
    model: 'configured-model',
    effort: 'high'
  })
  expect(rig.store.getRecord(SESSION)?.options?.model).toBeUndefined()
})

it('resets to an original configured model even when it is absent from the picker catalog', async () => {
  await rig.workingSend({ model: 'picked-model' })
  const read = catalog(true)
  read.mockResolvedValue({
    ...(await read()),
    models: [],
    defaultModelOptions: { model: 'unlisted-configured', effort: 'medium' }
  })
  expect(await pick('model', null)).toMatchObject({
    ok: true,
    value: { options: { model: 'unlisted-configured' } }
  })
  expect(read).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: SESSION,
      inSessionWorkspace: true,
      requireConfiguredDefault: true
    })
  )
})

it('replaying a reset after a newer explicit pick reports the current selection', async () => {
  catalog(true)
  const fields = { key: 'model', value: null }
  const params = {
    envelope: rig.envelope(fields, 'agentSession.setOption', hostTestOperationId()),
    ...fields
  }
  expect(await rig.host.setOption(QUEUED_RIG_CALLER, params)).toMatchObject({ ok: true })
  await pick('model', 'newer-model')
  expect(await rig.host.setOption(QUEUED_RIG_CALLER, params)).toMatchObject({
    ok: true,
    replayed: true,
    value: { modelDefault: false, options: { model: 'newer-model' } }
  })
})

it('refuses a live reset when the catalog default is only a recommendation', async () => {
  await rig.workingSend({ model: 'picked-model' })
  catalog(false)
  expect(await pick('model', null)).toMatchObject({ ok: false })
  expect(rig.store.getRecord(SESSION)?.defaultModelOptions).toBeUndefined()
})

it.each([true, false])(
  'previews the original configured default separately from the explicit current model (readsWithoutModel=%s)',
  async (readsWithoutModel) => {
    const read = catalog(true)
    const sessionId = await unstartedChat('preview-explicit')
    const options = await rig.host.readOptions(sessionId, { readsWithoutModel })
    expect(options.current.model).toBe('picked-model')
    expect(options).toHaveProperty('defaultModel', { id: 'configured-model', label: 'Configured' })
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({
        savedOnly: true,
        verifiedOnly: true,
        requireConfiguredDefault: true
      })
    )
  }
)

it.each([true, false])(
  'keeps the saved Default baseline when host configuration later changes (readsWithoutModel=%s)',
  async (readsWithoutModel) => {
    const read = catalog(true)
    const sessionId = await unstartedChat('preview-saved-default')
    await pick('model', null, sessionId)
    read.mockResolvedValue({
      ...(await read()),
      defaultModelOptions: { model: 'changed-configured-model', effort: 'medium' }
    })
    const options = await rig.host.readOptions(sessionId, { readsWithoutModel })
    expect(options.current.model).toBe('configured-model')
    expect(options).toHaveProperty('defaultModel', { id: 'configured-model', label: 'Configured' })
  }
)

it.each([true, false])(
  'does not preview the recommendation as the original default without configuration evidence (readsWithoutModel=%s)',
  async (readsWithoutModel) => {
    catalog(false)
    expect(
      await rig.host.readOptions(await unstartedChat('preview-unproven'), {
        readsWithoutModel
      })
    ).not.toHaveProperty('defaultModel')
  }
)

it.each([true, false])(
  'previews an unlisted configured default by its proven id (readsWithoutModel=%s)',
  async (readsWithoutModel) => {
    const read = catalog(true)
    read.mockResolvedValue({
      ...(await read()),
      models: [],
      defaultModelOptions: { model: 'unlisted-original', effort: 'medium' }
    })
    expect(
      await rig.host.readOptions(await unstartedChat('preview-unlisted'), {
        readsWithoutModel
      })
    ).toHaveProperty('defaultModel', { id: 'unlisted-original', label: 'unlisted-original' })
  }
)

it.each([true, false])(
  'keeps a pending catalog listing from promising a concrete Default model (readsWithoutModel=%s)',
  async (readsWithoutModel) => {
    const read = catalog(true)
    const listing = { ...(await read()), listingInProgress: true as const }
    read.mockResolvedValue(listing)
    expect(
      await rig.host.readOptions(await unstartedChat('preview-listing'), { readsWithoutModel })
    ).not.toHaveProperty('defaultModel')
  }
)

it('keeps chat effort choices independent of the configured model inventory', async () => {
  catalog(true)
  expect(await pick('model', null)).toMatchObject({ ok: true })
  expect(await pick('effort', 'high')).toMatchObject({ ok: true })
  expect(rig.store.getRecord(SESSION)?.options?.effort).toBe('high')
  expect(await pick('effort', 'medium')).toMatchObject({ ok: true })
})

it.each(['configured-model', 'another-model'])(
  'a later explicit pick of %s leaves Default and keeps compatible effort',
  async (model) => {
    catalog(true)
    expect(await pick('model', null)).toMatchObject({ ok: true })
    expect(await pick('model', model)).toMatchObject({ ok: true })
    const record = rig.store.getRecord(SESSION)
    if (!record) {
      throw new Error('expected the session')
    }
    const child = optionSession(async () => ({}))
    child.options = new Map([
      ['model', model],
      ['effort', 'high']
    ])
    child.reportedOptions = { model, effort: 'high' }
    expect(await resolvedCodexMessageOptions(child, effectiveAgentSessionOptions(record))).toEqual({
      model,
      effort: 'medium'
    })
    expect(record.defaultModelOptions).toBeUndefined()
    expect(record.options).toEqual({ model, effort: 'medium' })
  }
)

it('accepts null only for a model reset and rejects undefined', () => {
  const envelope = rig.envelope(
    { key: 'model', value: null },
    'agentSession.setOption',
    hostTestOperationId()
  )
  expect(SetOptionParams.safeParse({ envelope, key: 'model', value: null }).success).toBe(true)
  expect(SetOptionParams.safeParse({ envelope, key: 'effort', value: null }).success).toBe(false)
  expect(SetOptionParams.safeParse({ envelope, key: 'model', value: undefined }).success).toBe(
    false
  )
})
