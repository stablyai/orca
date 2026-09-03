import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import { reconcileLifecycleMessage } from '../../orchestration/lifecycle-reconciliation'
import {
  createNewWorktreeTestSupport,
  type NewWorktreeTestState
} from './orchestration-workers-new-worktree.test-support'

describe('orchestration new-worktree argv workers', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let runId: string
  let workerLaunchTokenHash: string | null
  const paths: string[] = []
  const support = createNewWorktreeTestSupport({
    getWorkerLaunchTokenHash: () => workerLaunchTokenHash,
    setWorkerLaunchTokenHash: (hash) => {
      workerLaunchTokenHash = hash
    }
  })

  beforeEach(() => {
    const state = support.setup()
    db = state.db
    runtime = state.runtime
    runId = state.runId
  })

  afterEach(() => support.cleanup(db, paths))

  function state(): NewWorktreeTestState {
    return { db, runtime, runId }
  }

  function startWorker(overrides: Record<string, unknown> = {}) {
    return support.startWorker(state(), overrides)
  }

  function mockCreatedWorktree(): void {
    support.mockCreatedWorktree(state())
  }

  function ownedResourceCount(dispatchId: string): number {
    return support.ownedResourceCount(db, dispatchId)
  }

  it('creates an independent top-level worktree and reuses its agent terminal', async () => {
    mockCreatedWorktree()

    const { result } = await startWorker({ worktree: 'new-top-level' })

    expect(runtime.createManagedWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        startupAgent: 'codex',
        awaitTerminalProvisioning: true,
        observeSetupCompletion: true,
        lineage: expect.objectContaining({ noParent: true, parentWorktree: undefined })
      })
    )
    expect(result).toMatchObject({ state: 'ready' })
    expect(result).toHaveProperty(
      'effects',
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'worktree',
          action: 'created_top_level',
          id: 'repo::created'
        }),
        expect.objectContaining({
          kind: 'terminal',
          role: 'agent',
          action: 'created',
          id: 'term_worker'
        })
      ])
    )
    expect(runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
    const createOptions = vi.mocked(runtime.createManagedWorktree).mock.calls[0]?.[0]
    expect(await createOptions?.startupPromptFactory?.('repo::created')).toMatch(
      /--dispatch-capability dcap_[A-Za-z0-9_-]+/
    )
    expect(ownedResourceCount((result as { dispatchId: string }).dispatchId)).toBe(1)
    expect(runtime.createTerminal).not.toHaveBeenCalled()
  })

  it('launches an argv worker in a new child worktree without prompt submission', async () => {
    mockCreatedWorktree()

    const { result } = await startWorker({ worktree: 'new-child' })

    expect(result).toMatchObject({ state: 'ready' })
    expect(runtime.createManagedWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        startupAgent: 'codex',
        startupLaunchToken: expect.any(String),
        startupPreAllocatedHandle: 'term_worker',
        lineage: expect.objectContaining({ parentWorktree: 'repo::parent', noParent: false })
      })
    )
    const createOptions = vi.mocked(runtime.createManagedWorktree).mock.calls[0]?.[0]
    expect(await createOptions?.startupPromptFactory?.('repo::created')).toMatch(
      /--dispatch-capability dcap_[A-Za-z0-9_-]+/
    )
    expect(runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
    expect(
      (result as { effects: { kind: string; role?: string; action?: string }[] }).effects.filter(
        (effect) => effect.kind === 'terminal' && effect.role === 'agent'
      )
    ).toHaveLength(1)
    expect(ownedResourceCount((result as { dispatchId: string }).dispatchId)).toBe(1)
  })

  it('accepts worker_done sent while argv startup is waiting for terminal readiness', async () => {
    mockCreatedWorktree()
    vi.mocked(runtime.waitForTerminal).mockImplementationOnce(async () => {
      const task = db.listTasks()[0]!
      const dispatch = db.getDispatchContext(task.id)!
      const message = db.insertMessage({
        from: 'term_worker',
        to: `run:${runId}`,
        subject: 'Completed immediately',
        type: 'worker_done',
        payload: JSON.stringify({
          taskId: task.id,
          dispatchId: dispatch.id,
          outcome: 'succeeded'
        }),
        senderPaneKey: 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        runId
      })

      expect(reconcileLifecycleMessage(db, message)).toEqual({
        action: 'completed',
        taskId: task.id,
        dispatchId: dispatch.id
      })
      return {
        handle: 'term_worker',
        condition: 'tui-idle',
        satisfied: true,
        status: 'running',
        exitCode: null
      }
    })

    const { result, task } = await startWorker({ worktree: 'new-child' })

    expect(result).toMatchObject({
      state: 'succeeded',
      stage: 'settled',
      taskId: task.id,
      effects: expect.arrayContaining([
        expect.objectContaining({ kind: 'dispatch_input', state: 'accepted' })
      ])
    })
    expect(db.getTask(task.id)).toMatchObject({ status: 'completed' })
  })

  it('keeps a bound argv worker ready and reports a blocked startup screen', async () => {
    mockCreatedWorktree()
    const blockedReason = 'trust prompt is waiting for confirmation'
    vi.mocked(runtime.waitForTerminal).mockResolvedValueOnce({
      handle: 'term_worker',
      condition: 'tui-idle',
      satisfied: false,
      status: 'running',
      blockedReason,
      exitCode: null
    } as never)
    const insertMessage = vi.spyOn(db, 'insertMessage')
    const notify = vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})

    const { result, task } = await startWorker({ worktree: 'new-child' })

    expect(result).toMatchObject({ state: 'ready', taskId: task.id })
    expect(db.getWorkerDispatch((result as { dispatchId: string }).dispatchId)).toMatchObject({
      state: 'ready'
    })
    expect(insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        priority: 'high',
        subject: expect.stringContaining(`startup blocked: ${blockedReason}`)
      })
    )
    expect(notify).toHaveBeenCalled()
  })

  it('keeps a bound argv worker ready when readiness has no blocked reason', async () => {
    mockCreatedWorktree()
    vi.mocked(runtime.waitForTerminal).mockResolvedValueOnce({
      handle: 'term_worker',
      condition: 'tui-idle',
      satisfied: false,
      status: 'running',
      exitCode: null
    } as never)
    const insertMessage = vi.spyOn(db, 'insertMessage')

    const { result, task } = await startWorker({ worktree: 'new-child' })
    const dispatchId = (result as { dispatchId: string }).dispatchId

    expect(result).toMatchObject({ state: 'ready' })
    expect(db.getTask(task.id)?.status).toBe('dispatched')
    expect(db.getDispatchContextById(dispatchId)).toMatchObject({
      status: 'dispatched',
      capability_revoked_at: null,
      capability_hash: expect.any(String)
    })
    expect(db.getWorkerDispatch(dispatchId)).toMatchObject({
      state: 'ready',
      stage: 'input_accepted'
    })
    expect(insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.stringContaining(
          'startup blocked: Terminal readiness wait was not satisfied.'
        )
      })
    )
  })
})
