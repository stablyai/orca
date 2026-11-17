import { afterEach, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/dispatch-row-writer'
import { structuredWorkersOwingWork } from './structured-worker-custody'

let db: OrchestrationDb | undefined
afterEach(() => db?.close())

const location = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'workspace_1',
  workspaceKind: 'folder'
} as const

/** `count` local workers that each own their terminal; every other one still has an open Dispatch. */
function workers(orchestration: OrchestrationDb, count: number) {
  const run = orchestration.createRun({
    objective: `workers ${count}`,
    coordinatorHandle: `term_coordinator_${count}`,
    coordinatorPaneKey: `tab_coordinator_${count}:dddddddd-dddd-4ddd-8ddd-dddddddddddd`
  })
  return Array.from({ length: count }, (_, index) => {
    const sessionId = `worker-${index}-of-${count}`
    const task = orchestration.createTask({ runId: run.id, spec: `task ${index}` })
    const dispatch = orchestration.createDispatchContext({
      taskId: task.id,
      assigneeHandle: `term_${sessionId}`,
      creator: { kind: 'system' },
      maxDepth: 9
    })
    orchestration.db
      .prepare('UPDATE dispatch_contexts SET process_incarnation = ?, status = ? WHERE id = ?')
      .run(`structured:${sessionId}`, index % 2 === 0 ? 'dispatched' : 'completed', dispatch.id)
    orchestration.db
      .prepare(
        `INSERT INTO worker_terminal_resources
           (id, origin_dispatch_id, owner_dispatch_id, terminal_handle, process_incarnation, host_scope)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        `resource_${sessionId}`,
        dispatch.id,
        dispatch.id,
        `term_${sessionId}`,
        `structured:${sessionId}`,
        JSON.stringify({ kind: 'local', hostId: 'local' })
      )
    return { sessionId, location }
  })
}

it('reads which of 10 or 100 workers owe Dispatch work in one statement', () => {
  db = new OrchestrationDb(':memory:')
  for (const count of [10, 100]) {
    const records = workers(db, count)
    const prepare = vi.spyOn(db.db, 'prepare')
    const owing = structuredWorkersOwingWork(db, records)
    expect(prepare).toHaveBeenCalledTimes(1)
    prepare.mockRestore()
    expect([...owing].sort()).toEqual(
      records
        .filter((_, index) => index % 2 === 0)
        .map((record) => record.sessionId)
        .sort()
    )
  }
})
