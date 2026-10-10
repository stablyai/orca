import { afterEach, expect, it, vi } from 'vitest'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import { agentSessionBackgroundStopTarget } from '../../../shared/agent-session-background-stop-target'
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

const child: AgentChildWorkView = {
  id: 'child-1',
  providerId: 'task-1',
  kind: 'agent',
  state: 'working',
  membership: 'live',
  firstObservedAt: NOW,
  observedAt: NOW,
  stoppable: true,
  invocation: { invocationId: 'invocation-1', generation: 1 }
}
const fields = {
  scope: 'background-tasks' as const,
  taskId: 'task-1',
  stopTarget: agentSessionBackgroundStopTarget([child])
}

function stopParams(testRig: QueuedMessageTestRig) {
  return {
    ...fields,
    envelope: testRig.envelope(fields, 'agentSession.cancel', hostTestOperationId())
  }
}

let rig: QueuedMessageTestRig | undefined
afterEach(async () => {
  vi.restoreAllMocks()
  await rig?.dispose()
  rig = undefined
})

it('does not answer an unavailable execution-host child roster as a successfully ended task', async () => {
  rig = await createQueuedMessageTestRig()
  let readFails = false
  rig.host.deps.statusSink = {
    publish: () => {},
    forget: () => {},
    readChildWork: () => {
      if (readFails) {
        throw new Error('host child store temporarily unreadable')
      }
      return [child]
    }
  }
  await rig.workingSend()
  const stopBackgroundTasks = vi.fn(async () => ({ cancelled: true }))
  rig.host.deps.adapter.stopBackgroundTasks = stopBackgroundTasks
  const params = stopParams(rig)
  const before = await rig.host.journalSnapshot(SESSION)
  readFails = true
  const result = await rig.host.cancel(QUEUED_RIG_CALLER, params)
  expect(result).toMatchObject({
    ok: false,
    refusal: { code: 'agent_session_operation_unknown', details: { reason: 'outcomeUnknown' } }
  })
  expect(stopBackgroundTasks).not.toHaveBeenCalled()
  expect(await rig.host.journalSnapshot(SESSION)).toEqual(before)
  expect(
    rig.store.getOperationRow(QUEUED_RIG_CALLER.callerKey, params.envelope.clientOperationId)
  ).toBeNull()
  readFails = false
  expect(await rig.host.cancel(QUEUED_RIG_CALLER, params)).toMatchObject({
    ok: true,
    value: { cancelled: true }
  })
  expect(stopBackgroundTasks).toHaveBeenCalledOnce()
  expect(stopBackgroundTasks).toHaveBeenCalledWith(expect.objectContaining({ taskIds: ['task-1'] }))
  expect(
    rig.store.getOperationRow(QUEUED_RIG_CALLER.callerKey, params.envelope.clientOperationId)
  ).toBeNull()
})

it('does not bypass the execution writer if an unavailable child roster recovers during admission', async () => {
  rig = await createQueuedMessageTestRig()
  let failNextRead = false
  rig.host.deps.statusSink = {
    publish: () => {},
    forget: () => {},
    readChildWork: () => {
      if (failNextRead) {
        failNextRead = false
        throw new Error('one transient host child read failure')
      }
      return [child]
    }
  }
  await rig.workingSend()
  const stopBackgroundTasks = vi.fn(async () => ({ cancelled: true }))
  rig.host.deps.adapter.stopBackgroundTasks = stopBackgroundTasks
  await rig.store.transitionHandoff(SESSION, (record) => ({
    ...record,
    lease: { ...record.lease, claimStatus: 'released', ownerProcess: null }
  }))
  failNextRead = true
  const result = await rig.host.cancel(QUEUED_RIG_CALLER, stopParams(rig))
  expect(stopBackgroundTasks).not.toHaveBeenCalled()
  expect(result).toMatchObject({ ok: false, refusal: { code: 'agent_session_ownership_unknown' } })
})

it.each(['live', 'new-invocation', 'ended'])(
  're-derives unavailable evidence after writer admission: %s',
  async (recovered) => {
    rig = await createQueuedMessageTestRig()
    const readChildWork = vi.fn(() => [child])
    rig.host.deps.statusSink = { publish: () => {}, forget: () => {}, readChildWork }
    await rig.workingSend()
    const stopBackgroundTasks = vi.fn(async () => ({ cancelled: true }))
    rig.host.deps.adapter.stopBackgroundTasks = stopBackgroundTasks
    readChildWork.mockClear()
    readChildWork
      .mockImplementationOnce(() => {
        throw new Error('one transient host child read failure')
      })
      .mockReturnValue(
        recovered === 'ended'
          ? []
          : recovered === 'new-invocation'
            ? [{ ...child, invocation: { ...child.invocation, generation: 2 } }]
            : [child]
      )
    const params = stopParams(rig)
    expect(await rig.host.cancel(QUEUED_RIG_CALLER, params)).toMatchObject({
      ok: true,
      value: { cancelled: recovered === 'live' }
    })
    if (recovered === 'live') {
      expect(stopBackgroundTasks).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ taskIds: ['task-1'] })
      )
    } else {
      expect(stopBackgroundTasks).not.toHaveBeenCalled()
    }
    expect(readChildWork).toHaveBeenCalledTimes(2)
    expect(
      rig.store.getOperationRow(QUEUED_RIG_CALLER.callerKey, params.envelope.clientOperationId)
    ).toBeNull()
  }
)

it('keeps a positively ended admission as a no-op when a later roster read would be live', async () => {
  rig = await createQueuedMessageTestRig()
  const readChildWork = vi.fn(() => [child])
  rig.host.deps.statusSink = { publish: () => {}, forget: () => {}, readChildWork }
  await rig.workingSend()
  const stopBackgroundTasks = vi.fn(async () => ({ cancelled: true }))
  rig.host.deps.adapter.stopBackgroundTasks = stopBackgroundTasks
  await rig.store.transitionHandoff(SESSION, (record) => ({
    ...record,
    lease: { ...record.lease, claimStatus: 'released', ownerProcess: null }
  }))
  readChildWork.mockClear().mockReturnValueOnce([])
  expect(await rig.host.cancel(QUEUED_RIG_CALLER, stopParams(rig))).toMatchObject({
    ok: true,
    value: { cancelled: false }
  })
  expect(stopBackgroundTasks).not.toHaveBeenCalled()
  expect(readChildWork).toHaveBeenCalledOnce()
})

it('uses the admitted live roster without another bookkeeping read before the provider Stop', async () => {
  rig = await createQueuedMessageTestRig()
  const readChildWork = vi.fn(() => [child])
  rig.host.deps.statusSink = { publish: () => {}, forget: () => {}, readChildWork }
  await rig.workingSend()
  const stopBackgroundTasks = vi.fn(async () => ({ cancelled: true }))
  rig.host.deps.adapter.stopBackgroundTasks = stopBackgroundTasks
  readChildWork
    .mockClear()
    .mockReturnValueOnce([child])
    .mockImplementation(() => {
      throw new Error('host child store became unreadable')
    })
  expect(await rig.host.cancel(QUEUED_RIG_CALLER, stopParams(rig))).toMatchObject({
    ok: true,
    value: { cancelled: true }
  })
  expect(stopBackgroundTasks).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ taskIds: ['task-1'] })
  )
  expect(readChildWork).toHaveBeenCalledOnce()
})

it('reports an unpublished parent roster as unconfirmed and allows the unchanged Stop after publication', async () => {
  rig = await createQueuedMessageTestRig()
  let publishFails = true
  rig.host.deps.statusSink = {
    publish: () => {
      if (publishFails) {
        throw new Error('parent publication unavailable')
      }
    },
    forget: () => {},
    readChildWork: () => [child]
  }
  await rig.workingSend()
  const stopBackgroundTasks = vi.fn(async () => ({ cancelled: true }))
  rig.host.deps.adapter.stopBackgroundTasks = stopBackgroundTasks
  const params = stopParams(rig)
  expect(await rig.host.cancel(QUEUED_RIG_CALLER, params)).toMatchObject({
    ok: false,
    refusal: { code: 'agent_session_operation_unknown' }
  })
  expect(stopBackgroundTasks).not.toHaveBeenCalled()
  publishFails = false
  const unsubscribe = rig.host.subscribeStatus({ id: 'republish', emit: () => {} })
  try {
    expect(await rig.host.cancel(QUEUED_RIG_CALLER, params)).toMatchObject({
      ok: true,
      value: { cancelled: true }
    })
    expect(stopBackgroundTasks).toHaveBeenCalledOnce()
  } finally {
    unsubscribe()
  }
})

it('reports a provider Stop write failure without silently claiming the task ended', async () => {
  rig = await createQueuedMessageTestRig()
  rig.host.deps.statusSink = { publish: () => {}, forget: () => {}, readChildWork: () => [child] }
  await rig.workingSend()
  const stopBackgroundTasks = vi.fn(async () => {
    throw new Error('provider Stop failed')
  })
  rig.host.deps.adapter.stopBackgroundTasks = stopBackgroundTasks
  const params = stopParams(rig)
  expect(await rig.host.cancel(QUEUED_RIG_CALLER, params)).toMatchObject({
    ok: false,
    refusal: { code: 'agent_session_operation_unknown' }
  })
  expect(stopBackgroundTasks).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ taskIds: ['task-1'] })
  )
  expect(
    rig.store.getOperationRow(QUEUED_RIG_CALLER.callerKey, params.envelope.clientOperationId)
  ).toBeNull()
})
