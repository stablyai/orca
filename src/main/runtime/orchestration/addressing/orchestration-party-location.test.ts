import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { OrchestrationDb } from '../db/orchestration-db'
import '../db/contract-constants'
import '../db/messages/mailbox-routing-page'
import '../db/dispatch-row-writer'
import '../db/attempt-outcome-projection'
import { locateOrchestrationParty } from './orchestration-party-location'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('locates a starting worker at its placed terminal before hand-over binds its assignee', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-party-location-'))
  dirs.push(dir)
  const db = new OrchestrationDb(join(dir, 'orchestration.db'))
  const task = db.createTask({ runId: 'run_legacy_local', spec: 'slow start' })
  const { dispatch } = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskId: task.id,
    startOptions: {}
  })
  db.recordWorkerStage({
    dispatchId: dispatch.id,
    stage: 'terminal_readying',
    worktreeId: 'repo::worker',
    terminalHandle: 'term_starting'
  })
  const located = locateOrchestrationParty(`dispatch:${dispatch.id}`, {
    db,
    records: null,
    terminalPaneKey: (handle) => (handle === 'term_starting' ? 'tab_1:pane' : null),
    terminalHandleForPaneKey: () => null
  })
  expect(located).toEqual({ location: { kind: 'terminal', handle: 'term_starting' } })
  db.close()
})
