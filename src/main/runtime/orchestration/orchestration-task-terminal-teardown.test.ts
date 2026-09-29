import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeTerminalClose } from '../../../shared/runtime-terminal-contracts'
import { OrchestrationDb } from './db'
import type { OrchestrationTaskTerminalEvent } from './orchestration-task-terminal-event'
import {
  TERMINAL_STILL_LIVE_ERROR,
  teardownOrchestrationTaskTerminal,
  type TaskTerminalTeardownPorts
} from './orchestration-task-terminal-teardown'

const WORKER_PANE = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const COORD_PANE = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const WORKTREE_ID = 'repo::worktree'

describe('orchestration task terminal teardown', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
  })

  it('treats a completed task whose PTY is still live as a failure', async () => {
    const { task, dispatch } = settleSucceededWorker()
    const updates: Record<string, unknown>[] = []
    const result = await teardownOrchestrationTaskTerminal(
      requireDb(),
      event(task.id, dispatch.id, 'completed'),
      ports({
        inspections: [inspection('live'), inspection('live')],
        close: { handle: 'term_worker', tabId: 'tab_worker', ptyKilled: true },
        updates
      })
    )

    expect(result).toMatchObject({ provedExited: false, error: TERMINAL_STILL_LIVE_ERROR })
    expect(db?.getDispatchContextById(dispatch.id)?.last_failure).toBe(TERMINAL_STILL_LIVE_ERROR)
    expect(db?.getWorkerDispatch(dispatch.id)?.last_error).toBe(TERMINAL_STILL_LIVE_ERROR)
    expect(JSON.parse(db?.getTask(task.id)?.result ?? '{}')).toMatchObject({
      terminalTeardownError: TERMINAL_STILL_LIVE_ERROR
    })
    expect(updates).toEqual([{ comment: TERMINAL_STILL_LIVE_ERROR }])
  })

  it('does not mark the worktree completed when the stop stays unverifiable', async () => {
    const { task, dispatch } = settleSucceededWorker()
    const updates: Record<string, unknown>[] = []
    const result = await teardownOrchestrationTaskTerminal(
      requireDb(),
      event(task.id, dispatch.id, 'completed'),
      ports({
        inspections: [
          inspection('unverifiable', 'its SSH provider is no longer registered'),
          inspection('unverifiable', 'its SSH provider is no longer registered')
        ],
        close: {
          handle: 'term_worker',
          tabId: 'tab_worker',
          ptyKilled: false,
          ptyStopVerdict: 'unverifiable',
          ptyStopReason: 'its SSH provider is no longer registered'
        },
        updates
      })
    )

    expect(result.provedExited).toBe(false)
    expect(result.error).toContain('not confirmed stopped')
    expect(updates.every((update) => update.workspaceStatus === undefined)).toBe(true)
    expect(db?.getTask(task.id)?.result).toContain('not confirmed stopped')
  })

  it('sets the worktree to completed only after the PTY is proved exited', async () => {
    const { task, dispatch } = settleSucceededWorker()
    const updates: Record<string, unknown>[] = []
    const result = await teardownOrchestrationTaskTerminal(
      requireDb(),
      event(task.id, dispatch.id, 'completed'),
      ports({
        inspections: [inspection('live'), inspection('exited')],
        close: { handle: 'term_worker', tabId: 'tab_worker', ptyKilled: true },
        updates
      })
    )

    expect(result).toEqual({ provedExited: true, error: null })
    expect(updates).toEqual([{ workspaceStatus: 'completed' }])
    expect(db?.getDispatchContextById(dispatch.id)?.last_failure).toBeNull()
  })

  it('sets the worktree to failed when a failed task agent is gone', async () => {
    const { task, dispatch } = settleSucceededWorker()
    requireDb().updateTaskStatus(task.id, 'failed', 'build broke')
    const updates: Record<string, unknown>[] = []
    await teardownOrchestrationTaskTerminal(
      requireDb(),
      event(task.id, dispatch.id, 'failed'),
      ports({
        inspections: [inspection('exited')],
        updates
      })
    )

    expect(updates).toEqual([{ workspaceStatus: 'failed' }])
  })

  it('does not archive a blocked worktree when a cancelled worker is already gone', async () => {
    const { task, dispatch } = openReadyWorker()
    requireDb().abandonWorkerDispatch(dispatch.id)
    const updates: Record<string, unknown>[] = []
    const result = await teardownOrchestrationTaskTerminal(
      requireDb(),
      event(task.id, dispatch.id, 'cancelled'),
      ports({
        inspections: [inspection('exited')],
        updates
      })
    )

    expect(result.provedExited).toBe(true)
    expect(updates).toEqual([])
  })

  it('emits teardown when a worker report completes the task', async () => {
    const seen: OrchestrationTaskTerminalEvent[] = []
    const { task, dispatch } = openReadyWorker()
    const database = requireDb()
    database.taskTerminalTeardown = (next) => {
      seen.push(next)
    }
    database.settleWorkerReport({
      taskId: task.id,
      dispatchId: dispatch.id,
      outcome: 'succeeded',
      result: JSON.stringify({ provenance: 'worker_report', outcome: 'succeeded' })
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(seen).toEqual([{ taskId: task.id, dispatchId: dispatch.id, kind: 'completed' }])
  })

  function settleSucceededWorker(): { task: { id: string }; dispatch: { id: string } } {
    const opened = openReadyWorker()
    requireDb().settleWorkerReport({
      taskId: opened.task.id,
      dispatchId: opened.dispatch.id,
      outcome: 'succeeded',
      result: JSON.stringify({ provenance: 'worker_report', outcome: 'succeeded' })
    })
    return opened
  }

  function openReadyWorker(): { task: { id: string }; dispatch: { id: string } } {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'Teardown',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: COORD_PANE
    })
    const task = db.createTask({ spec: 'finish the work', runId: run.id })
    const started = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {},
      runtimeEpoch: 'runtime-1'
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_worker',
      paneKey: WORKER_PANE,
      processIncarnation: 'runtime:pty:1',
      worktreeId: WORKTREE_ID,
      setupState: 'not_applicable',
      effects: [{ kind: 'terminal', action: 'created', id: 'term_worker' }],
      terminalOwnership: 'created'
    })
    db.markWorkerDispatchReady(started.dispatch.id)
    return { task, dispatch: started.dispatch }
  }

  function requireDb(): OrchestrationDb {
    if (!db) {
      throw new Error('orchestration db was not opened')
    }
    return db
  }
})

function event(
  taskId: string,
  dispatchId: string,
  kind: OrchestrationTaskTerminalEvent['kind']
): OrchestrationTaskTerminalEvent {
  return { taskId, dispatchId, kind }
}

function inspection(
  status: 'live' | 'exited' | 'unverifiable',
  reason?: string
): Awaited<ReturnType<TaskTerminalTeardownPorts['inspect']>> {
  return {
    status,
    terminalHandle: 'term_worker',
    ...(reason ? { reason } : {})
  }
}

function ports(options: {
  inspections: Awaited<ReturnType<TaskTerminalTeardownPorts['inspect']>>[]
  close?: RuntimeTerminalClose
  updates: Record<string, unknown>[]
}): TaskTerminalTeardownPorts {
  let index = 0
  return {
    inspect: () => {
      const next = options.inspections[Math.min(index, options.inspections.length - 1)]
      index += 1
      return Promise.resolve(next)
    },
    closeTerminal: () =>
      Promise.resolve(
        options.close ?? { handle: 'term_worker', tabId: 'tab_worker', ptyKilled: true }
      ),
    stopStructured: () => Promise.resolve({ stopped: true }),
    releaseFederated: () => Promise.resolve({ provedExited: true, error: null }),
    readWorktreeComment: () => Promise.resolve(''),
    applyWorkspace: (_worktreeId, update) => {
      options.updates.push(update)
      return Promise.resolve()
    }
  }
}
