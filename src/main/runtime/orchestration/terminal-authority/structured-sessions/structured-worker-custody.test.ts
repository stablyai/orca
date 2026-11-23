import { afterEach, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/dispatch-row-writer'
import { structuredWorkerIncarnation, structuredWorkerOwesWork } from './structured-worker-custody'

let db: OrchestrationDb | undefined
afterEach(() => db?.close())

const worker = {
  sessionId: 'worker-a',
  location: {
    executionHostId: 'local',
    wslDistro: null,
    workspaceId: 'workspace',
    workspaceKind: 'folder'
  }
} as const

it("finds an owned worker's open Dispatch by incarnation, not by scanning other Dispatches", () => {
  const orchestration = (db = new OrchestrationDb(':memory:'))
  const run = orchestration.createRun({
    objective: 'workers',
    coordinatorHandle: 'term_coordinator',
    coordinatorPaneKey: 'tab_coordinator:dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  })
  const task = orchestration.createTask({ runId: run.id, spec: 'work' })
  const dispatch = orchestration.createDispatchContext({
    taskId: task.id,
    assigneeHandle: 'term_worker',
    creator: { kind: 'system' },
    maxDepth: 9
  })
  const incarnation = structuredWorkerIncarnation(worker.sessionId)
  orchestration.db
    .prepare('UPDATE dispatch_contexts SET process_incarnation = ? WHERE id = ?')
    .run(incarnation, dispatch.id)
  orchestration.db
    .prepare(
      `INSERT INTO worker_terminal_resources
         (id, origin_dispatch_id, owner_dispatch_id, terminal_handle, process_incarnation, host_scope)
       VALUES ('resource-a', ?, ?, 'term_worker', ?, ?)`
    )
    .run(dispatch.id, dispatch.id, incarnation, JSON.stringify({ kind: 'local', hostId: 'local' }))
  const prepare = vi.spyOn(orchestration.db, 'prepare')

  expect(structuredWorkerOwesWork(orchestration, worker)).toBe(true)
  const read = prepare.mock.calls
    .map(([sql]) => String(sql))
    .find((sql) => sql.includes('FROM dispatch_contexts'))
  prepare.mockRestore()
  const plan = orchestration.db
    .prepare(`EXPLAIN QUERY PLAN ${read}`)
    .all(incarnation)
    .map((step) =>
      typeof step === 'object' && step !== null && 'detail' in step ? step.detail : ''
    )
  expect(plan.join('\n')).toContain('idx_dispatch_contexts_incarnation_status')
})
