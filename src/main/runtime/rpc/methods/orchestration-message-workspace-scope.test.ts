import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { ORCHESTRATION_METHODS } from './orchestration'

function findMethod(name: string) {
  const method = ORCHESTRATION_METHODS.find((candidate) => candidate.name === name)
  if (!method) {
    throw new Error(`Method not found: ${name}`)
  }
  return method
}

async function call(ctx: RpcContext, name: string, params: Record<string, unknown>) {
  const method = findMethod(name)
  const parsed = method.params ? method.params.parse(params) : undefined
  return method.handler(parsed, ctx)
}

describe('orchestration RPC workspace ownership', () => {
  let db: OrchestrationDb

  afterEach(() => db?.close())

  it('rejects task creation from an explicit stale terminal without inserting a global task', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)

    await expect(
      call({ runtime }, 'orchestration.taskCreate', {
        spec: 'must not become global',
        callerTerminalHandle: 'term_stale'
      })
    ).rejects.toThrow()

    expect(db.listTasks()).toHaveLength(0)
  })

  it('creates a global task when the runtime resolves the caller to global scope', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'resolveWorkspaceKeyForTerminalHandle').mockResolvedValue(null)

    const result = (await call({ runtime }, 'orchestration.taskCreate', {
      spec: 'global floating-terminal task',
      callerTerminalHandle: 'term_floating'
    })) as { task: { workspace_key: string | null } }

    expect(result.task.workspace_key).toBeNull()
    expect(db.listTasks()).toHaveLength(1)
  })

  it('scopes each group status copy to its recipient before sender fallback', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = {
      getOrchestrationDb: () => db,
      getTerminalPaneKey: () => null,
      listTerminals: vi.fn(async () => ({
        terminals: [
          { handle: 'term_sender', worktreeId: 'wt_sender' },
          { handle: 'term_coord', worktreeId: 'wt_coord' },
          { handle: 'term_worker', worktreeId: 'wt_worker' },
          { handle: 'term_fallback', worktreeId: 'wt_fallback' }
        ]
      })),
      getAgentStatusForHandle: () => null,
      deliverPendingMessagesForHandle: vi.fn(),
      notifyMessageArrived: vi.fn()
    } as unknown as OrcaRuntimeService
    const ctx = { runtime }

    db.createCoordinatorRun({
      spec: 'coordinate',
      coordinatorHandle: 'term_coord',
      workspaceKey: 'worktree:wt_coord'
    })
    const workerTask = db.createTask({ spec: 'worker', workspaceKey: 'worktree:wt_worker' })
    db.createDispatchContext(workerTask.id, 'term_worker')
    const senderTask = db.createTask({ spec: 'sender', workspaceKey: 'worktree:wt_sender' })
    db.createDispatchContext(senderTask.id, 'term_sender')

    const result = (await call(ctx, 'orchestration.send', {
      from: 'term_sender',
      to: '@all',
      subject: 'status update',
      type: 'status'
    })) as { messages: { to_handle: string; workspace_key: string | null }[] }
    const scopes = Object.fromEntries(
      result.messages.map((message) => [message.to_handle, message.workspace_key])
    )

    expect(scopes).toEqual({
      term_coord: 'worktree:wt_coord',
      term_worker: 'worktree:wt_worker',
      term_fallback: 'worktree:wt_sender'
    })
  })
})
