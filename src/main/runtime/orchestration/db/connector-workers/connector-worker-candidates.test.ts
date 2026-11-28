import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import '../contract-constants'
import '../messages/mailbox-routing-page'
import '../dispatch-row-writer'
import '../attempt-outcome-projection'
import { createOrcaSessionId } from '../../../../../shared/agent-session/identity/orca-session-address'
import { readConnectorWorkerCandidates } from './connector-worker-candidates'

let directory: string
let db: OrchestrationDb
let runId: string
const chat = createOrcaSessionId(randomUUID)
// Rows are stamped and read at one fixed time.
const NOW = Date.UTC(2026, 10, 26, 12)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
  directory = mkdtempSync(join(tmpdir(), 'orca-connector-worker-candidates-'))
  db = new OrchestrationDb(join(directory, 'orchestration.db'))
  runId = db.createRun({
    objective: 'thread',
    coordinatorHandle: null,
    coordinatorPaneKey: null
  }).id
})

afterEach(() => {
  vi.useRealTimers()
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

function startWorker(creatorDispatchId?: string): string {
  const task = db.createTask({ runId, spec: 'work' })
  const { dispatch } = db.createStartingWorkerDispatch({
    creator: { kind: 'session', orcaSessionId: chat },
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskId: task.id,
    startOptions: {}
  })
  db.db
    .prepare(
      `UPDATE dispatch_contexts SET creator_turn_source = ?, creator_dispatch_id = ? WHERE id = ?`
    )
    .run(creatorDispatchId ? null : 'connector', creatorDispatchId ?? null, dispatch.id)
  db.prepareStartingWorkerAuthority({
    dispatchId: dispatch.id,
    handle: `term_agent_${dispatch.id}`,
    paneKey: `tab_${dispatch.id}:leaf-agent-${dispatch.id}`,
    processIncarnation: 'pty-live:22222222-2222-4222-8222-222222222222',
    worktreeId: 'repo::/worktrees/child',
    hostScope: JSON.stringify({ kind: 'local', hostId: 'local' }),
    setupState: 'succeeded',
    effects: [],
    terminalOwnership: 'created'
  })
  return dispatch.id
}

const openChildrenOf = () =>
  readConnectorWorkerCandidates(db, [chat], NOW).candidates.map((candidate) => [
    candidate.row.dispatchId,
    candidate.openChildren
  ])

it("marks a thread's worker whose own helpers are still open, and only while they are", () => {
  const lead = startWorker()
  expect(openChildrenOf()).toEqual([[lead, false]])
  const helper = startWorker(lead)
  // The helper isn't the thread's: the conversation read never lists it, only its lead's mark.
  expect(openChildrenOf()).toEqual([[lead, true]])
  db.db.prepare(`UPDATE dispatch_contexts SET status = 'completed' WHERE id = ?`).run(helper)
  expect(openChildrenOf()).toEqual([[lead, false]])
})
