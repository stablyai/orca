import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import type { CoordinatorRuntime } from './coordinator-runtime-contract'
import { dispatchTaskToWorker } from './coordinator-task-dispatch'

const WORKER_PANE_KEY = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
let db: OrchestrationDb

function createRuntime(promptError: Error | null): CoordinatorRuntime & { prompts: string[] } {
  const prompts: string[] = []
  return {
    prompts,
    async sendTerminalAgentPrompt(_handle: string, prompt: string) {
      prompts.push(prompt)
      if (promptError) {
        throw promptError
      }
      return { accepted: true }
    },
    async listTerminals() {
      return { terminals: [] }
    },
    async createTerminal() {
      return { handle: 'term_a', worktreeId: 'wt1' }
    },
    async waitForTerminal(handle: string) {
      return { handle, condition: 'exit' }
    },
    async probeWorktreeDrift() {
      return null
    },
    getTerminalPaneKey() {
      return WORKER_PANE_KEY
    },
    getOrchestrationDispatchAuthority() {
      return {
        paneKey: WORKER_PANE_KEY,
        processIncarnation: 'incarnation-1',
        launchTokenHash: null
      }
    }
  }
}

async function dispatch(
  runtime: CoordinatorRuntime,
  taskId: string,
  logs: string[]
): Promise<string> {
  return dispatchTaskToWorker({
    db,
    runtime,
    task: db.getTask(taskId)!,
    targetHandle: 'term_a',
    nestedWorkerMaxDepth: Number.MAX_SAFE_INTEGER,
    baseDrift: null,
    coordinatorHandle: 'coord',
    worktree: undefined,
    onLog: (message) => logs.push(message),
    onCircuitBroken: () => undefined
  })
}

describe('coordinator dispatch with an unobserved prompt', () => {
  afterEach(() => db?.close())

  it('never re-pastes a preamble whose turn start was not observed', async () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'do the work' })
    const runtime = createRuntime(new Error('agent_prompt_stalled'))
    const logs: string[] = []

    const result = await dispatch(runtime, task.id, logs)

    expect(result).toBe('dispatched-unobserved')
    expect(runtime.prompts).toHaveLength(1)
    // The task stays dispatched, so the next coordinator tick cannot pick it up again.
    expect(db.getTask(task.id)?.status).toBe('dispatched')
    const ctx = db.getDispatchContext(task.id)
    expect(ctx).toMatchObject({
      status: 'dispatched',
      failure_count: 0,
      capability_revoked_at: null
    })
    expect(db.listTasks({ status: 'ready' })).toEqual([])
    expect(logs.join('\n')).toContain('turn start was not observed')
  })

  it('lets a late worker report settle a dispatch whose prompt was unobserved', async () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'do the work' })
    await dispatch(createRuntime(new Error('agent_prompt_stalled')), task.id, [])
    const dispatchId = db.getDispatchContext(task.id)!.id
    const minted = db.mintDispatchCapability({
      dispatchId,
      paneKey: WORKER_PANE_KEY,
      processIncarnation: 'incarnation-1'
    })

    expect(
      db.verifyDispatchCapability({
        dispatchId,
        capability: minted,
        paneKey: WORKER_PANE_KEY,
        processIncarnation: 'incarnation-1'
      })
    ).toEqual({ valid: true })
    expect(
      db.settleWorkerReport({
        taskId: task.id,
        dispatchId,
        outcome: 'succeeded',
        result: 'done the work'
      })
    ).toEqual({ action: 'settled', outcome: 'succeeded', duplicate: false })
    expect(db.getTask(task.id)).toMatchObject({ status: 'completed', result: 'done the work' })
    expect(db.getDispatchContextById(dispatchId)?.status).toBe('completed')
  })

  it('still fails the dispatch when the prompt was never delivered', async () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'do the work' })
    const runtime = createRuntime(new Error('terminal_not_writable'))

    await expect(dispatch(runtime, task.id, [])).rejects.toThrow('terminal_not_writable')

    expect(db.getTask(task.id)?.status).toBe('ready')
    expect(db.getDispatchContext(task.id)).toMatchObject({
      status: 'failed',
      failure_count: 1,
      last_failure: 'terminal_not_writable'
    })
  })
})
