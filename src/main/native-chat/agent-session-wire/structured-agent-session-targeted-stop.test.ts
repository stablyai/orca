import { afterEach, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import {
  createQueuedMessageTestRig,
  QUEUED_RIG_CALLER,
  eventually,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestOperationId
} from './structured-agent-session-host-test-data'

let rig: QueuedMessageTestRig | undefined
afterEach(async () => {
  vi.restoreAllMocks()
  await rig?.dispose()
  rig = undefined
})

it('targets a turn without a receipt and cannot stop the next turn after retry or restart', async () => {
  rig = await createQueuedMessageTestRig({ stopEndsSession: true, restartable: true })
  await rig.workingSend()
  const identity = {
    provider: 'legacy' as const,
    agent: 'codex',
    sessionId: SESSION,
    recordId: 'turn:one'
  }
  rig
    .providerEvents()
    .appendItem(
      identity,
      { kind: 'turn', turnId: 'one', state: 'running' },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  await eventually(async () =>
    expect((await rig!.host.journalSnapshot(SESSION)).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ body: expect.objectContaining({ turnId: 'one' }) })
      ])
    )
  )
  const stopTarget = { kind: 'turn' as const, turnId: 'one' }
  const fields = { stopTarget }
  const id = hostTestOperationId()
  const params = { ...fields, envelope: rig.envelope(fields, 'agentSession.cancel', id) }
  expect(await rig.host.cancel(QUEUED_RIG_CALLER, params)).toMatchObject({
    ok: true,
    value: { cancelled: true }
  })
  expect(rig.store.getOperationRow(QUEUED_RIG_CALLER.callerKey, id)).toBeNull()
  await rig.restartHostProcess()
  await rig.workingSend()
  rig
    .providerEvents()
    .appendItem(
      { ...identity, recordId: 'turn:two' },
      { kind: 'turn', turnId: 'two', state: 'running' },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  await rig.host.flushAllStreamedEvents()
  const calls = rig.cancelTurn.mock.calls.length
  const closes = rig.closeSession.mock.calls.length
  expect(await rig.host.cancel(QUEUED_RIG_CALLER, params)).toMatchObject({
    ok: true,
    value: { cancelled: false }
  })
  expect(rig.cancelTurn).toHaveBeenCalledTimes(calls)
  expect(rig.closeSession).toHaveBeenCalledTimes(closes)
})

it('targets an unanswered submission without growing receipts or interrupting a later send', async () => {
  rig = await createQueuedMessageTestRig({ restartable: true })
  const first = await rig.workingSend()
  const stopTarget = { kind: 'submission' as const, clientMessageId: first }
  const id = hostTestOperationId()
  const params = { stopTarget, envelope: rig.envelope({ stopTarget }, 'agentSession.cancel', id) }
  const admission = vi.spyOn(rig.store, 'recordOperationOutcome')
  expect(await rig.host.cancel(QUEUED_RIG_CALLER, params)).toMatchObject({
    ok: true,
    value: { cancelled: true }
  })
  expect(rig.store.getOperationRow(QUEUED_RIG_CALLER.callerKey, id)).toBeNull()
  expect(admission).not.toHaveBeenCalled()
  const next = rig.send('later send')
  expect(await next.result).toMatchObject({ ok: true })
  const calls = rig.cancelTurn.mock.calls.length
  expect(await rig.host.cancel(QUEUED_RIG_CALLER, params)).toMatchObject({
    ok: true,
    value: { cancelled: false }
  })
  expect(rig.cancelTurn).toHaveBeenCalledTimes(calls)
})

it('stops a waiting submission even when a later send is queued before the Stop lands', async () => {
  rig = await createQueuedMessageTestRig({ restartable: true })
  const first = await rig.workingSend()
  const stopTarget = { kind: 'submission' as const, clientMessageId: first }
  const later = rig.send('sent just before Stop')
  expect(await later.result).toMatchObject({ ok: true })
  const queued = await rig.submission(later.id)
  expect(queued).toMatchObject({ handoverRecorded: true, dispatchState: 'pending' })
  expect(queued?.handedOverAt).toBeUndefined()
  const id = hostTestOperationId()
  const params = { stopTarget, envelope: rig.envelope({ stopTarget }, 'agentSession.cancel', id) }
  expect(await rig.host.cancel(QUEUED_RIG_CALLER, params)).toMatchObject({
    ok: true,
    value: { cancelled: true }
  })
  expect(rig.cancelTurn).toHaveBeenCalled()
})

it('keeps target and fingerprint validation when a Stop cannot write its receipt', async () => {
  rig = await createQueuedMessageTestRig({ restartable: true })
  await rig.workingSend()
  const stopTarget = { kind: 'turn' as const, turnId: 'gone' }
  const envelope = rig.envelope({ stopTarget }, 'agentSession.cancel', hostTestOperationId())
  expect(
    await rig.host.cancel(QUEUED_RIG_CALLER, {
      envelope: { ...envelope, payloadFingerprint: 'wrong' },
      stopTarget
    })
  ).toMatchObject({ ok: false })
  expect(rig.cancelTurn).not.toHaveBeenCalled()
})
