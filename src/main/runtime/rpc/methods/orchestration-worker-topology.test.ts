import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { TaskRow } from '../../orchestration/types'
import {
  createExistingWorktreeWorkerTerminal,
  resolveWorkerTerminalTitle
} from './orchestration/worker/worker-topology'

const task: TaskRow = {
  id: 'task-opaque',
  run_id: 'run-1',
  parent_id: null,
  created_by_terminal_handle: null,
  created_by_pane_key: null,
  created_by_process_incarnation: null,
  created_by_run_generation: null,
  task_title: 'Implement progress projection',
  display_name: 'Progress worker',
  spec: 'Build the runtime-owned progress projection.',
  status: 'ready',
  deps: '[]',
  result: null,
  created_at: '2026-08-28T10:00:00.000Z',
  completed_at: null
}

describe('orchestration worker topology titles', () => {
  it('uses the human display name instead of an opaque Task identifier', () => {
    expect(resolveWorkerTerminalTitle(task)).toBe('Progress worker')
  })

  it('preserves an explicit user rename', () => {
    expect(resolveWorkerTerminalTitle(task, 'My pinned worker')).toBe('My pinned worker')
  })

  it('creates an existing-worktree terminal with the human Task title', async () => {
    const createTerminal = vi.fn(async () => ({
      handle: 'terminal-1',
      surface: 'background' as const
    }))
    const runtime = {
      getOrchestrationDb: () => ({ getTask: () => task }),
      createTerminal
    } as unknown as OrcaRuntimeService

    const result = await createExistingWorktreeWorkerTerminal({
      runtime,
      worktreeId: 'worktree-1',
      agent: 'codex',
      taskId: task.id,
      effects: []
    })

    expect(result.handle).toBe('terminal-1')
    expect(createTerminal).toHaveBeenCalledWith(
      'id:worktree-1',
      expect.objectContaining({
        title: 'Progress worker',
        surfaceOwner: false,
        orchestrationManagedLaunch: true
      })
    )
  })
})
