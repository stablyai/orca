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
import {
  AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS,
  AGENT_SESSION_OPERATION_FUTURE_SKEW_MS
} from '../../../shared/agent-session-host-authority'

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

let rig: QueuedMessageTestRig | undefined
afterEach(async () => {
  vi.restoreAllMocks()
  await rig?.dispose()
  rig = undefined
})

it.each([false, true])(
  'retries a lost task Stop reply without restarting a released provider: %s',
  async (restart) => {
    let now = NOW
    rig = await createQueuedMessageTestRig({ now: () => now })
    let children = [child]
    rig.host.deps.statusSink = {
      publish: () => {},
      forget: () => {},
      readChildWork: () => children
    }
    await rig.workingSend()
    const stopBackgroundTasks = vi.fn(async () => {
      children = [{ ...child, state: 'done', membership: 'settled' }]
      return { cancelled: true }
    })
    rig.host.deps.adapter.stopBackgroundTasks = stopBackgroundTasks
    const fields = {
      scope: 'background-tasks' as const,
      taskId: 'task-1',
      stopTarget: agentSessionBackgroundStopTarget(children)
    }
    const id = hostTestOperationId()
    const params = { ...fields, envelope: rig.envelope(fields, 'agentSession.cancel', id) }
    expect(await rig.host.cancel(QUEUED_RIG_CALLER, params)).toMatchObject({
      ok: true,
      value: { cancelled: true }
    })
    expect(stopBackgroundTasks).toHaveBeenCalledWith(
      expect.objectContaining({ taskIds: ['task-1'] })
    )
    await rig.host.close(SESSION, 'user-close')
    now += AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS + AGENT_SESSION_OPERATION_FUTURE_SKEW_MS + 1
    if (restart) {
      await rig.restartHostProcess()
    }
    const acquire = vi.spyOn(rig.host.deps.adapter, 'acquire')
    expect(await rig.host.cancel(QUEUED_RIG_CALLER, params)).toMatchObject({
      ok: true,
      value: { cancelled: false }
    })
    expect(stopBackgroundTasks).toHaveBeenCalledOnce()
    expect(acquire).not.toHaveBeenCalled()
    expect(rig.store.getOperationRow(QUEUED_RIG_CALLER.callerKey, id)).toBeNull()
  }
)

it.each(['new-invocation', 'new-child'])(
  'cannot stop later work reusing a task handle: %s',
  async (change) => {
    rig = await createQueuedMessageTestRig()
    const children = [
      {
        ...child,
        ...(change === 'new-child'
          ? { id: 'child-2' }
          : {
              invocation: { ...child.invocation, generation: 2 }
            })
      }
    ]
    rig.host.deps.statusSink = {
      publish: () => {},
      forget: () => {},
      readChildWork: () => children
    }
    await rig.workingSend()
    const stopBackgroundTasks = vi.fn(async () => ({ cancelled: true }))
    rig.host.deps.adapter.stopBackgroundTasks = stopBackgroundTasks
    const fields = {
      scope: 'background-tasks' as const,
      taskId: 'task-1',
      stopTarget: agentSessionBackgroundStopTarget([child])
    }
    expect(
      await rig.host.cancel(QUEUED_RIG_CALLER, {
        ...fields,
        envelope: rig.envelope(fields, 'agentSession.cancel', hostTestOperationId())
      })
    ).toMatchObject({ ok: true, value: { cancelled: false } })
    expect(stopBackgroundTasks).not.toHaveBeenCalled()
  }
)

it.each([false, true])(
  'requires the execution writer for a live task (targeted: %s)',
  async (targeted) => {
    rig = await createQueuedMessageTestRig()
    rig.host.deps.statusSink = {
      publish: () => {},
      forget: () => {},
      readChildWork: () => [child]
    }
    await rig.workingSend()
    const stopBackgroundTasks = vi.fn(async () => ({ cancelled: true }))
    rig.host.deps.adapter.stopBackgroundTasks = stopBackgroundTasks
    await rig.store.transitionHandoff(SESSION, (record) => ({
      ...record,
      lease: { ...record.lease, claimStatus: 'released', ownerProcess: null }
    }))
    const fields = {
      scope: 'background-tasks' as const,
      taskId: 'task-1',
      ...(targeted ? { stopTarget: agentSessionBackgroundStopTarget([child]) } : {})
    }
    expect(
      await rig.host.cancel(QUEUED_RIG_CALLER, {
        ...fields,
        envelope: rig.envelope(fields, 'agentSession.cancel', hostTestOperationId())
      })
    ).toMatchObject({ ok: false, refusal: { code: 'agent_session_ownership_unknown' } })
    expect(stopBackgroundTasks).not.toHaveBeenCalled()
  }
)
