import { afterEach, expect, it, vi } from 'vitest'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
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

let rig: QueuedMessageTestRig | undefined
afterEach(async () => {
  vi.restoreAllMocks()
  await rig?.dispose()
  rig = undefined
})

function taskStop(testRig: QueuedMessageTestRig, taskId?: string) {
  const fields = {
    turnId: 'turn-1',
    scope: 'background-tasks' as const,
    ...(taskId ? { taskId } : {})
  }
  return {
    ...fields,
    envelope: testRig.envelope(fields, 'agentSession.cancel', hostTestOperationId())
  }
}

async function rigWithTaskList(): Promise<{
  testRig: QueuedMessageTestRig
  stopBackgroundTasks: ReturnType<typeof vi.fn>
  setReadFails: (fails: boolean) => void
}> {
  const testRig = await createQueuedMessageTestRig()
  rig = testRig
  let readFails = false
  testRig.host.deps.statusSink = {
    publish: () => {},
    forget: () => {},
    readChildWork: () => {
      if (readFails) {
        throw new Error('host child store temporarily unreadable')
      }
      return [child]
    }
  }
  await testRig.workingSend()
  const stopBackgroundTasks = vi.fn(async () => ({ cancelled: true }))
  testRig.host.deps.adapter.stopBackgroundTasks = stopBackgroundTasks
  return { testRig, stopBackgroundTasks, setReadFails: (fails) => void (readFails = fails) }
}

async function unconfirmedNotes(testRig: QueuedMessageTestRig) {
  return (await testRig.host.journalSnapshot(SESSION)).items.filter(
    (item) => item.body.kind === 'status' && item.body.failure?.kind === 'cancelUnconfirmed'
  )
}

for (const taskId of ['task-1', undefined]) {
  it(`answers ${taskId ? 'one task' : 'every task'}'s Stop unconfirmed while the task list cannot be read`, async () => {
    const { testRig, stopBackgroundTasks, setReadFails } = await rigWithTaskList()
    setReadFails(true)
    expect(await testRig.host.cancel(QUEUED_RIG_CALLER, taskStop(testRig, taskId))).toMatchObject({
      ok: true,
      value: { cancelled: false }
    })
    expect(stopBackgroundTasks).not.toHaveBeenCalled()
    expect(await unconfirmedNotes(testRig)).toHaveLength(1)
    setReadFails(false)
    expect(await testRig.host.cancel(QUEUED_RIG_CALLER, taskStop(testRig, taskId))).toMatchObject({
      ok: true,
      value: { cancelled: true }
    })
    expect(stopBackgroundTasks).toHaveBeenCalledOnce()
  })
}

it('still answers a task the readable list no longer offers as already ended', async () => {
  const { testRig, stopBackgroundTasks } = await rigWithTaskList()
  expect(
    await testRig.host.cancel(QUEUED_RIG_CALLER, taskStop(testRig, 'task-gone'))
  ).toMatchObject({ ok: true, value: { cancelled: false } })
  expect(stopBackgroundTasks).not.toHaveBeenCalled()
  expect(await unconfirmedNotes(testRig)).toHaveLength(0)
})
