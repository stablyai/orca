import { afterEach, expect, it, vi } from 'vitest'
import {
  AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS,
  AGENT_SESSION_OPERATION_FUTURE_SKEW_MS
} from '../../../shared/agent-session-host-authority'
import {
  createQueuedMessageTestRig,
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
let rig: QueuedMessageTestRig | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  await rig?.dispose()
  rig = undefined
})

it('delivers a delayed Stop to its still-unanswered host target beyond the work receipt window', async () => {
  let now = NOW
  rig = await createQueuedMessageTestRig({ now: () => now })
  const sentId = await rig.workingSend()
  const stopTarget = { kind: 'submission' as const, clientMessageId: sentId }
  const params = {
    stopTarget,
    envelope: rig.envelope({ stopTarget }, 'agentSession.cancel', hostTestOperationId())
  }
  now += AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS + AGENT_SESSION_OPERATION_FUTURE_SKEW_MS + 1
  const result = await rig.host.cancel(QUEUED_RIG_CALLER, params)
  expect(result).toMatchObject({ ok: true, value: { cancelled: true } })
  expect(rig.cancelTurn).toHaveBeenCalledOnce()
})
it.each([false, true])(
  'answers an expired ended target quietly after restart: %s',
  async (restart) => {
    let now = NOW
    rig = await createQueuedMessageTestRig({
      now: () => now,
      stopEndsSession: true,
      restartable: true
    })
    const sentId = await rig.workingSend()
    const stopTarget = { kind: 'submission' as const, clientMessageId: sentId }
    const params = {
      stopTarget,
      envelope: rig.envelope({ stopTarget }, 'agentSession.cancel', hostTestOperationId())
    }
    expect(await rig.host.cancel(QUEUED_RIG_CALLER, params)).toMatchObject({
      ok: true,
      value: { cancelled: true }
    })
    await rig.host.close(SESSION, 'user-close')
    now += AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS + AGENT_SESSION_OPERATION_FUTURE_SKEW_MS + 1
    if (restart) {
      await rig.restartHostProcess()
    }
    const acquire = vi.spyOn(rig.host.deps.adapter, 'acquire')
    const closes = rig.closeSession.mock.calls.length
    const result = await rig.host.cancel(QUEUED_RIG_CALLER, params)
    expect(result).toMatchObject({ ok: true, value: { cancelled: false } })
    expect(rig.cancelTurn).toHaveBeenCalledOnce()
    expect(rig.closeSession).toHaveBeenCalledTimes(closes)
    expect(acquire).not.toHaveBeenCalled()
  }
)

it('answers an ended background target as a no-op after the provider was closed', async () => {
  rig = await createQueuedMessageTestRig()
  await rig.workingSend()
  await rig.host.close(SESSION, 'user-close')
  const acquire = vi.spyOn(rig.host.deps.adapter, 'acquire')
  const stopBackgroundTasks = vi.fn(async () => ({ cancelled: true }))
  rig.host.deps.adapter.stopBackgroundTasks = stopBackgroundTasks
  const fields = {
    scope: 'background-tasks' as const,
    turnId: 'background-tasks',
    stopTarget: {
      kind: 'background-tasks' as const,
      tasks: [{ id: 'ended-child', invocation: { invocationId: 'old-invocation', generation: 1 } }]
    }
  }
  const params = {
    ...fields,
    envelope: rig.envelope(fields, 'agentSession.cancel', hostTestOperationId())
  }
  const result = await rig.host.cancel(QUEUED_RIG_CALLER, params)
  expect(result).toMatchObject({ ok: true, value: { cancelled: false } })
  expect(acquire).not.toHaveBeenCalled()
  expect(stopBackgroundTasks).not.toHaveBeenCalled()
})

it('still validates an expired targeted Stop before any effect', async () => {
  let now = NOW
  rig = await createQueuedMessageTestRig({ now: () => now })
  const sentId = await rig.workingSend()
  const stopTarget = { kind: 'submission' as const, clientMessageId: sentId }
  const envelope = rig.envelope({ stopTarget }, 'agentSession.cancel', hostTestOperationId())
  now += AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS + AGENT_SESSION_OPERATION_FUTURE_SKEW_MS + 1
  expect(
    await rig.host.cancel(QUEUED_RIG_CALLER, {
      stopTarget,
      envelope: { ...envelope, payloadFingerprint: 'wrong' }
    })
  ).toMatchObject({ ok: false, refusal: { code: 'agent_session_operation_conflict' } })
  expect(
    await rig.host.cancel(QUEUED_RIG_CALLER, {
      stopTarget,
      envelope: { ...envelope, clientOperationId: 'invalid' }
    })
  ).toMatchObject({ ok: false, refusal: { code: 'agent_session_operation_invalid' } })
  expect(rig.cancelTurn).not.toHaveBeenCalled()
})
