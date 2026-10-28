import { afterEach, describe, expect, it, vi } from 'vitest'
import { Coordinator } from './coordinator'
import type { CoordinatorRuntime } from './coordinator-runtime-contract'
import { OrchestrationDb } from './db'

afterEach(() => vi.useRealTimers())

describe('coordinator terminal census availability', () => {
  it.each(['terminal_surface_ownership_unavailable', 'terminal_liveness_unavailable'])(
    'defers dispatch on %s and reuses the existing worker after recovery',
    async (error) => {
      vi.useFakeTimers()
      const db = new OrchestrationDb(':memory:')
      const task = db.createTask({ runId: 'run_legacy_local', spec: 'implement the feature' })
      const listTerminals = vi
        .fn<CoordinatorRuntime['listTerminals']>()
        .mockRejectedValueOnce(new Error(error))
        .mockResolvedValue({
          terminals: [
            { handle: 'term_existing', worktreeId: 'wt1', connected: true, writable: true }
          ]
        })
      const createTerminal = vi.fn<CoordinatorRuntime['createTerminal']>(async () => ({
        handle: 'term_unnecessary',
        worktreeId: 'wt1'
      }))
      const sendTerminalAgentPrompt = vi.fn<CoordinatorRuntime['sendTerminalAgentPrompt']>(
        async () => ({ accepted: true })
      )
      const runtime: CoordinatorRuntime = {
        listTerminals,
        createTerminal,
        sendTerminalAgentPrompt,
        waitForTerminal: async (handle) => ({ handle, condition: 'exit' }),
        probeWorktreeDrift: async () => null
      }
      const coordinator = new Coordinator(db, runtime, {
        spec: 'go',
        coordinatorHandle: 'coord',
        pollIntervalMs: 1000,
        worktree: 'wt1'
      })
      const run = coordinator.run()
      try {
        await vi.advanceTimersByTimeAsync(0)
        expect(listTerminals).toHaveBeenCalledTimes(1)
        expect(createTerminal).not.toHaveBeenCalled()
        expect(sendTerminalAgentPrompt).not.toHaveBeenCalled()
        expect(db.getTask(task.id)?.status).toBe('ready')
        expect(db.listTasks({ status: 'dispatched' })).toEqual([])

        await vi.advanceTimersByTimeAsync(1000)
        expect(listTerminals).toHaveBeenCalledTimes(2)
        expect(createTerminal).not.toHaveBeenCalled()
        expect(sendTerminalAgentPrompt).toHaveBeenCalledTimes(1)
        const dispatch = db.getDispatchContext(task.id)
        expect(dispatch?.assignee_handle).toBe('term_existing')
        expect(db.getTask(task.id)?.status).toBe('dispatched')
        db.insertMessage({
          runId: 'run_legacy_local',
          from: 'term_existing',
          to: 'coord',
          subject: 'Done',
          type: 'worker_done',
          payload: JSON.stringify({
            taskId: task.id,
            dispatchId: dispatch?.id,
            outcome: 'succeeded'
          })
        })
        await vi.advanceTimersByTimeAsync(1000)
        await expect(run).resolves.toMatchObject({ status: 'completed', completedTasks: [task.id] })
      } finally {
        coordinator.stop()
        try {
          await vi.runOnlyPendingTimersAsync()
          await run
        } finally {
          db.close()
        }
      }
    }
  )
})
