import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_METHODS } from './orchestration'
import { OrchestrationDb } from '../../orchestration/db'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcContext } from '../core'
import { OrchestrationRoleDeniedError } from '../../orchestration/role-lease'

describe('ORCH-R15 role lease RPC guards', () => {
  let db: OrchestrationDb
  let dbOpen = false
  let runtime: OrcaRuntimeService
  let ctx: RpcContext

  function setup(): void {
    db = new OrchestrationDb(':memory:')
    dbOpen = true
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) => {
      if (handle === 'term_worker') {
        return 'tab_w:leaf_w'
      }
      if (handle === 'term_coord') {
        return 'tab_c:leaf_c'
      }
      return null
    })
    ctx = { runtime }
  }

  afterEach(() => {
    if (!dbOpen) {
      return
    }
    dbOpen = false
    db.close()
  })

  function findMethod(name: string) {
    const method = ORCHESTRATION_METHODS.find((m) => m.name === name)
    if (!method) {
      throw new Error(`Method not found: ${name}`)
    }
    return method
  }

  async function call(name: string, params: Record<string, unknown>) {
    const method = findMethod(name)
    const parsed = method.params ? method.params.parse(params) : undefined
    return method.handler(parsed, ctx)
  }

  function dispatchWorker(paneKey = 'tab_w:leaf_w') {
    const task = db.createTask({ spec: 'worker task' })
    const dispatch = db.createDispatchContext(task.id, 'term_worker', paneKey)
    return { task, dispatch }
  }

  it('registers roleLeaseGrant', () => {
    expect(ORCHESTRATION_METHODS.some((m) => m.name === 'orchestration.roleLeaseGrant')).toBe(true)
  })

  it('denies post-worker_done gateCreate without mutating gates/tasks', async () => {
    setup()
    const { task, dispatch } = dispatchWorker()
    db.updateTaskStatus(task.id, 'completed')
    db.completeDispatch(dispatch.id)

    const beforeGateCount = db.listGates().length
    await expect(
      call('orchestration.gateCreate', {
        task: task.id,
        question: 'INC-3 recovery?',
        callerTerminalHandle: 'term_worker',
        callerPaneKey: 'tab_w:leaf_w'
      })
    ).rejects.toBeInstanceOf(OrchestrationRoleDeniedError)
    expect(db.listGates()).toHaveLength(beforeGateCount)
    expect(db.getTask(task.id)?.status).toBe('completed')
  })

  it('allows active-worker ask / decision_gate but denies taskCreate', async () => {
    setup()
    vi.spyOn(runtime, 'deliverPendingMessagesForHandle').mockImplementation(() => {})
    vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
    vi.spyOn(runtime, 'waitForMessage').mockResolvedValue(undefined)
    dispatchWorker()

    await expect(
      call('orchestration.taskCreate', {
        spec: 'should fail',
        callerTerminalHandle: 'term_worker',
        callerPaneKey: 'tab_w:leaf_w'
      })
    ).rejects.toBeInstanceOf(OrchestrationRoleDeniedError)

    // ask is allowed for active workers (opens decision_gate to coordinator).
    const askPromise = call('orchestration.ask', {
      to: 'term_coord',
      question: 'blocked?',
      from: 'term_worker',
      callerTerminalHandle: 'term_worker',
      callerPaneKey: 'tab_w:leaf_w',
      timeoutMs: 10
    })
    const outbound = db.getInbox(10).find((m) => m.type === 'decision_gate')
    expect(outbound).toBeTruthy()
    if (outbound) {
      db.insertMessage({
        from: 'term_coord',
        to: 'term_worker',
        subject: 'Re: Question',
        body: 'continue',
        threadId: outbound.id
      })
      runtime.notifyMessageArrived('term_worker', 'status')
    }
    const answer = (await askPromise) as { answer: string | null }
    expect(answer.answer).toBe('continue')
  })

  it('denies quarantined decision_gate send without inserting mail', async () => {
    setup()
    vi.spyOn(runtime, 'deliverPendingMessagesForHandle').mockImplementation(() => {})
    const { task, dispatch } = dispatchWorker()
    db.updateTaskStatus(task.id, 'completed')
    db.completeDispatch(dispatch.id)
    const before = db.getInbox(50).length

    await expect(
      call('orchestration.send', {
        from: 'term_worker',
        to: 'term_coord',
        subject: 'recovery gate',
        type: 'decision_gate',
        senderPaneKey: 'tab_w:leaf_w',
        callerTerminalHandle: 'term_worker',
        callerPaneKey: 'tab_w:leaf_w'
      })
    ).rejects.toBeInstanceOf(OrchestrationRoleDeniedError)
    expect(db.getInbox(50)).toHaveLength(before)
  })

  it('grants explicit coordinator lease and then allows taskCreate', async () => {
    setup()
    const { task, dispatch } = dispatchWorker()
    db.updateTaskStatus(task.id, 'completed')
    db.completeDispatch(dispatch.id)

    await expect(
      call('orchestration.roleLeaseGrant', {
        to: 'term_worker',
        from: 'term_worker',
        subjectPaneKey: 'tab_w:leaf_w',
        callerTerminalHandle: 'term_worker',
        callerPaneKey: 'tab_w:leaf_w'
      })
    ).rejects.toBeInstanceOf(OrchestrationRoleDeniedError)

    const granted = (await call('orchestration.roleLeaseGrant', {
      to: 'term_worker',
      from: 'term_coord',
      subjectPaneKey: 'tab_w:leaf_w',
      callerTerminalHandle: 'term_coord',
      callerPaneKey: 'tab_c:leaf_c'
    })) as { lease: { id: string; role: string } }
    expect(granted.lease.role).toBe('coordinator')

    const created = (await call('orchestration.taskCreate', {
      spec: 'coord work',
      callerTerminalHandle: 'term_worker',
      callerPaneKey: 'tab_w:leaf_w'
    })) as { task: { id: string } }
    expect(created.task.id).toMatch(/^task_/)
  })

  it('denies identity-less self-grant after dispatch history without mutation', async () => {
    setup()
    const { task, dispatch } = dispatchWorker()
    db.updateTaskStatus(task.id, 'completed')
    db.completeDispatch(dispatch.id)
    expect(
      db.findActiveCoordinatorLease({ handle: 'term_worker', paneKey: 'tab_w:leaf_w' })
    ).toBeUndefined()

    await expect(
      call('orchestration.roleLeaseGrant', {
        to: 'term_worker',
        from: 'term_unknown',
        subjectPaneKey: 'tab_w:leaf_w'
      })
    ).rejects.toBeInstanceOf(OrchestrationRoleDeniedError)
    expect(
      db.findActiveCoordinatorLease({ handle: 'term_worker', paneKey: 'tab_w:leaf_w' })
    ).toBeUndefined()
  })

  it('denies a live coordinator handle paired with the worker pane', async () => {
    setup()
    const { task, dispatch } = dispatchWorker()
    db.updateTaskStatus(task.id, 'completed')
    db.completeDispatch(dispatch.id)
    const beforeTasks = db.listTasks().length

    await expect(
      call('orchestration.taskCreate', {
        spec: 'forged coordinator',
        callerTerminalHandle: 'term_coord',
        callerPaneKey: 'tab_w:leaf_w'
      })
    ).rejects.toBeInstanceOf(OrchestrationRoleDeniedError)
    expect(db.listTasks()).toHaveLength(beforeTasks)
  })

  it('preserves worker_done / heartbeat sends for an active assignee', async () => {
    setup()
    vi.spyOn(runtime, 'deliverPendingMessagesForHandle').mockImplementation(() => {})
    vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
    const { task, dispatch } = dispatchWorker()

    const done = (await call('orchestration.send', {
      from: 'term_worker',
      to: 'term_coord',
      subject: 'done',
      type: 'worker_done',
      payload: JSON.stringify({ taskId: task.id, dispatchId: dispatch.id }),
      senderPaneKey: 'tab_w:leaf_w'
    })) as { message: { id: string; type: string } }
    expect(done.message.type).toBe('worker_done')
  })
})
