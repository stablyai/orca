import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './orchestration/db/orchestration-db'
import './orchestration/db/contract-constants'
import './orchestration/db/messages/mailbox-routing-page'
import './orchestration/db/dispatch-row-writer'
import './orchestration/db/attempt-outcome-projection'
import { createRootDispatch } from './orchestration/db/root-dispatch-test-fixture'
import { RuntimeOrchestrationSenderNames } from './runtime-orchestration-sender-names'

let db: OrchestrationDb
beforeEach(() => {
  db = new OrchestrationDb(':memory:')
})
afterEach(() => {
  db.close()
})
const terminalParty = (handle: string) => ({
  address: handle,
  terminalHandle: handle,
  orcaSessionId: null
})
const names = () =>
  new RuntimeOrchestrationSenderNames({
    getDb: () => db,
    getHandleRecord: () => undefined,
    getPtyAgents: () => undefined,
    getTerminalPaneKey: () => null,
    getWorkspaceSession: () => undefined,
    getGeneratedTitlesEnabled: () => false,
    getAgentStatusSnapshotForPane: () => undefined,
    getTrackedTitle: () => null
  })

it('keeps one-shot snapshots stateless and shares installation only between independent pass readers', () => {
  const run = db.createRun({
    objective: 'cache',
    coordinatorHandle: null,
    coordinatorPaneKey: null
  })
  const task = db.createTask({ runId: run.id, spec: 'Cache actor' })
  const dispatchId = createRootDispatch(db, task.id, 'term_gone').id
  const party = { address: `dispatch:${dispatchId}`, terminalHandle: null, orcaSessionId: null }
  const source = names()
  const sentinelSql = 'SELECT 1 AS sender_cache_sentinel'
  const sentinel = db.db.prepare(sentinelSql)
  const exec = vi.spyOn(db.db, 'exec')
  source.snapshotOf(party)
  source.snapshotOf(party)
  expect(exec).not.toHaveBeenCalled()
  expect(db.db.prepare(sentinelSql)).toBe(sentinel)
  const first = source.snapshotReader()
  first(party)
  expect(exec).toHaveBeenCalledTimes(1)
  const installedSentinel = db.db.prepare(sentinelSql)
  const worker = vi.spyOn(db, 'getWorkerDispatch')
  first(party)
  expect(worker).not.toHaveBeenCalled()
  source.snapshotReader()(party)
  expect(worker).toHaveBeenCalledTimes(1)
  source.snapshotOf(party)
  expect(worker).toHaveBeenCalledTimes(2)
  expect(exec).toHaveBeenCalledTimes(1)
  expect(db.db.prepare(sentinelSql)).toBe(installedSentinel)
})

it('never installs inside the first transaction and retries failed committed installation across replacement', () => {
  const source = names()
  const read = source.snapshotReader()
  const exec = vi.spyOn(db.db, 'exec')
  db.db.exec('BEGIN')
  exec.mockClear()
  expect(read(terminalParty('term_plain')).agent).toBeNull()
  expect(source.snapshotOf(terminalParty('term_plain')).agent).toBeNull()
  expect(exec).not.toHaveBeenCalled()
  db.db.exec('ROLLBACK')
  exec.mockClear()
  exec.mockImplementationOnce(() => {
    throw new Error('install unavailable')
  })
  expect(() => read(terminalParty('term_plain'))).toThrow('install unavailable')
  vi.spyOn(db.db, 'prepare').mockImplementationOnce(() => {
    throw new Error('generation unavailable')
  })
  expect(() => read(terminalParty('term_plain'))).toThrow('generation unavailable')
  expect(read(terminalParty('term_plain')).agent).toBeNull()
  expect(exec).toHaveBeenCalledTimes(3)
  source.snapshotReader()(terminalParty('term_plain'))
  expect(exec).toHaveBeenCalledTimes(3)
  db.close()
  db = new OrchestrationDb(':memory:')
  const replacedExec = vi.spyOn(db.db, 'exec')
  expect(read(terminalParty('term_plain')).agent).toBeNull()
  expect(replacedExec).toHaveBeenCalledTimes(1)
})
