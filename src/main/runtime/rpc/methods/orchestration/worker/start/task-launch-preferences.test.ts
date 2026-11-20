import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createOrchestrationWorkerReleaseHarness } from '../testing/worker-release.test-support'

describe('task launch preferences', () => {
  const h = createOrchestrationWorkerReleaseHarness()
  afterEach(() => h.cleanup())

  async function createTask(
    preferences: Record<string, unknown> = {
      model: 'gpt-6.1-sol',
      effort: 'high'
    }
  ): Promise<string> {
    const result = await h.call('orchestration.taskCreate', {
      spec: 'Plan the implementation',
      run: h.activeRunId,
      callerTerminalHandle: 'term_coord',
      ...preferences
    })
    return z.object({ task: z.object({ id: z.string() }) }).parse(result).task.id
  }

  it.each([
    { overrides: {}, expected: { model: 'gpt-6.1-sol', effort: 'high' } },
    { overrides: { effort: 'medium' }, expected: { model: 'gpt-6.1-sol', effort: 'medium' } },
    { overrides: { model: 'gpt-6-luna' }, expected: { model: 'gpt-6-luna' } },
    {
      overrides: { model: 'gpt-6-luna', effort: 'low' },
      expected: { model: 'gpt-6-luna', effort: 'low' }
    }
  ])(
    'launches with task defaults and explicit overrides: $overrides',
    async ({ overrides, expected }) => {
      h.setup()
      const task = await createTask()
      await expect(
        h.call('orchestration.workerStart', {
          task,
          from: 'term_coord',
          agent: 'codex',
          ...overrides
        })
      ).resolves.toMatchObject({ state: 'ready' })
      expect(h.runtime.createTerminal).toHaveBeenCalledWith(
        'id:repo::worktree',
        expect.objectContaining({
          launchPreferences: expected
        })
      )
      expect(h.db.getTask(task)).toMatchObject({ model: 'gpt-6.1-sol', effort: 'high' })
    }
  )

  it('keeps task defaults for a retry after an overridden attempt fails', async () => {
    h.setup()
    const task = await createTask()
    const first = z.object({ dispatchId: z.string() }).parse(
      await h.call('orchestration.workerStart', {
        task,
        from: 'term_coord',
        agent: 'codex',
        model: 'gpt-6-luna'
      })
    )
    h.settle(task, first.dispatchId, 'failed')
    await expect(
      h.call('orchestration.workerStart', {
        task,
        from: 'term_coord',
        agent: 'codex',
        retryOf: first.dispatchId
      })
    ).resolves.toMatchObject({ state: 'ready' })
    expect(h.runtime.createTerminal).toHaveBeenLastCalledWith(
      'id:repo::worktree',
      expect.objectContaining({
        launchPreferences: { model: 'gpt-6.1-sol', effort: 'high' }
      })
    )
  })

  it('validates inherited model and effort before launching', async () => {
    h.setup()
    const task = await createTask({ model: 'gpt-6.1-sol', effort: 'invalid-effort' })
    await expect(
      h.call('orchestration.workerStart', {
        task,
        from: 'term_coord',
        agent: 'codex'
      })
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(h.runtime.createTerminal).not.toHaveBeenCalled()
    expect(h.db.getTask(task)?.status).toBe('ready')
  })

  it('keeps a reused terminal configuration while still refusing explicit model overrides', async () => {
    h.setup()
    const task = await createTask()
    await expect(
      h.call('orchestration.workerStart', {
        task,
        from: 'term_coord',
        terminal: 'term_worker',
        model: 'gpt-6-luna'
      })
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(
      h.call('orchestration.workerStart', {
        task,
        from: 'term_coord',
        terminal: 'term_worker'
      })
    ).resolves.toMatchObject({ state: 'ready' })
    expect(h.runtime.createTerminal).not.toHaveBeenCalled()
    expect(h.db.getTask(task)).toMatchObject({ model: 'gpt-6.1-sol', effort: 'high' })
  })

  it.each([{ effort: 'high' }, { model: '' }, { model: ' padded ' }])(
    'rejects malformed task preferences before creating a task: %j',
    async (preferences) => {
      h.setup()
      await expect(createTask(preferences)).rejects.toThrow()
      expect(h.db.listTasks({ runId: h.activeRunId })).toEqual([])
    }
  )
})
