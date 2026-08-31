import { describe, expect, it, vi } from 'vitest'
import type { RuntimeClient } from '../../runtime-client'
import { executeMissionRun } from './mission-supervisor'

type TaskState = {
  id: string
  status: 'pending' | 'ready' | 'dispatched' | 'completed' | 'failed' | 'blocked'
}

function response<T>(result: T) {
  return { id: 'test', ok: true as const, result, _meta: { runtimeId: 'runtime-test' } }
}

describe('mission supervisor start waves', () => {
  it('waits for a later concurrent start and its active worker before reporting an earlier start failure', async () => {
    const tasks = new Map<string, TaskState>([
      ['task_a', { id: 'task_a', status: 'ready' }],
      ['task_b', { id: 'task_b', status: 'ready' }]
    ])
    const workerStartTasks: string[] = []
    let releaseSecondStart!: () => void
    const secondStart = new Promise<void>((resolve) => {
      releaseSecondStart = resolve
    })
    const call = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'orchestration.taskCreate') {
        const id = params?.displayName === 'a' ? 'task_a' : 'task_b'
        return response({ task: { id, status: 'ready' } })
      }
      if (method === 'orchestration.taskList') {
        return response({ runId: 'run_wave', tasks: [...tasks.values()], count: tasks.size })
      }
      if (method === 'orchestration.workerStart') {
        const taskId = String(params?.task)
        workerStartTasks.push(taskId)
        if (taskId === 'task_a') {
          tasks.get(taskId)!.status = 'failed'
          return response({
            runId: 'run_wave',
            taskId,
            dispatchId: 'ctx_a',
            state: 'failed',
            failedStage: 'dispatch_input',
            lastError: 'A prompt delivery outcome is ambiguous.'
          })
        }
        await secondStart
        tasks.get(taskId)!.status = 'dispatched'
        return response({ runId: 'run_wave', taskId, dispatchId: 'ctx_b', state: 'ready' })
      }
      if (method === 'orchestration.check' && params?.wait) {
        tasks.get('task_b')!.status = 'completed'
        return response({
          deliveryId: null,
          timedOut: false,
          cancelled: false,
          connectionLost: false
        })
      }
      throw new Error(`unexpected method: ${method}`)
    })
    const client = { call, isRemote: false } as unknown as RuntimeClient
    const run = executeMissionRun({
      client,
      mission: 'concurrent failure',
      runId: 'run_wave',
      from: 'term_coord',
      worktree: 'id:repo::worktree',
      agent: 'codex',
      tasks: [
        { key: 'a', spec: 'A', deps: [] },
        { key: 'b', spec: 'B', deps: [] }
      ],
      maxConcurrency: 2
    })
    let settled = false
    void run.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )

    await vi.waitFor(() => expect(workerStartTasks).toEqual(['task_a', 'task_b']))
    await Promise.resolve()
    expect(settled).toBe(false)

    releaseSecondStart()

    await expect(run).rejects.toMatchObject({
      code: 'mission_worker_start_failed',
      message: 'A prompt delivery outcome is ambiguous.'
    })
    expect(workerStartTasks).toEqual(['task_a', 'task_b'])
    expect(call).toHaveBeenCalledWith(
      'orchestration.check',
      expect.objectContaining({ run: 'run_wave', wait: true })
    )
  })

  it('preserves a single nonretryable start failure without another worker start', async () => {
    const task: TaskState = { id: 'task_only', status: 'ready' }
    const call = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'orchestration.taskCreate') {
        return response({ task: { id: task.id, status: task.status } })
      }
      if (method === 'orchestration.taskList') {
        return response({ runId: 'run_only', tasks: [task], count: 1 })
      }
      if (method === 'orchestration.workerStart') {
        task.status = 'failed'
        return response({
          runId: 'run_only',
          taskId: String(params?.task),
          dispatchId: 'ctx_only',
          state: 'failed',
          failedStage: 'dispatch_input',
          lastError: 'Prompt delivery outcome is ambiguous.'
        })
      }
      throw new Error(`unexpected method: ${method}`)
    })
    const client = { call, isRemote: false } as unknown as RuntimeClient

    await expect(
      executeMissionRun({
        client,
        mission: 'single failure',
        runId: 'run_only',
        from: 'term_coord',
        worktree: 'id:repo::worktree',
        agent: 'codex',
        tasks: [{ key: 'only', spec: 'Only task', deps: [] }],
        maxConcurrency: 1
      })
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'mission_worker_start_failed',
        message: 'Prompt delivery outcome is ambiguous.'
      })
    )
    expect(
      call.mock.calls.filter(([method]) => method === 'orchestration.workerStart')
    ).toHaveLength(1)
  })
})
