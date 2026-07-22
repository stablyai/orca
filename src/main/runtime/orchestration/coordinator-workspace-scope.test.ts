import { afterEach, describe, expect, it, vi } from 'vitest'
import { Coordinator, type CoordinatorRuntime } from './coordinator'
import { OrchestrationDb } from './db'

function createRuntimeWithoutWorkers(): CoordinatorRuntime {
  return {
    async sendTerminalAgentPrompt() {
      return {}
    },
    async listTerminals() {
      return { terminals: [] }
    },
    async createTerminal() {
      throw new Error('no terminals in test')
    },
    async waitForTerminal(handle: string) {
      return { handle, condition: 'idle' }
    },
    async probeWorktreeDrift() {
      return null
    }
  }
}

describe('Coordinator workspace-scoped message payloads', () => {
  let db: OrchestrationDb

  afterEach(() => db?.close())

  it('does not mutate foreign tasks named by escalation or decision-gate payloads', async () => {
    db = new OrchestrationDb(':memory:')
    const ownWorkspace = 'worktree:wt_b'
    const foreignWorkspace = 'worktree:wt_a'
    db.createTask({ spec: 'keep coordinator alive', workspaceKey: ownWorkspace })

    const escalationTask = db.createTask({
      spec: 'foreign dispatched task',
      workspaceKey: foreignWorkspace
    })
    const foreignDispatch = db.createDispatchContext(escalationTask.id, 'term_foreign')
    const gateTask = db.createTask({ spec: 'foreign gate task', workspaceKey: foreignWorkspace })

    const escalation = db.insertMessage({
      from: 'term_b_worker',
      to: 'coord_b',
      subject: 'malicious foreign escalation',
      type: 'escalation',
      payload: JSON.stringify({ taskId: escalationTask.id }),
      workspaceKey: ownWorkspace
    })
    const decisionGate = db.insertMessage({
      from: 'term_b_worker',
      to: 'coord_b',
      subject: 'malicious foreign gate',
      type: 'decision_gate',
      payload: JSON.stringify({ taskId: gateTask.id, question: 'Block the foreign task?' }),
      workspaceKey: ownWorkspace
    })

    const coordinator = new Coordinator(db, createRuntimeWithoutWorkers(), {
      spec: 'workspace B coordinator',
      coordinatorHandle: 'coord_b',
      pollIntervalMs: 5,
      workspaceKey: ownWorkspace
    })
    const run = coordinator.run()

    await vi.waitFor(() => {
      expect(db.getMessageById(escalation.id)?.read).toBe(1)
      expect(db.getMessageById(decisionGate.id)?.read).toBe(1)
    })
    coordinator.stop()
    await run

    expect(db.getDispatchContextById(foreignDispatch.id)?.status).toBe('dispatched')
    expect(db.getTask(escalationTask.id)?.status).toBe('dispatched')
    expect(db.getTask(gateTask.id)?.status).toBe('ready')
    expect(db.listGates({ taskId: gateTask.id })).toHaveLength(0)
  })
})
