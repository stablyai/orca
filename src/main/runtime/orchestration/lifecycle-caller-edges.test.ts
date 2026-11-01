import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'

let db: OrchestrationDb | undefined
let directory: string | undefined

afterEach(() => {
  db?.close()
  if (directory) {
    rmSync(directory, { recursive: true, force: true })
  }
  db = undefined
  directory = undefined
})

function createDatabase(): OrchestrationDb {
  directory = mkdtempSync(join(tmpdir(), 'orca-lifecycle-edges-'))
  db = new OrchestrationDb(join(directory, 'orchestration.db'))
  return db
}

function startWorker(database: OrchestrationDb, taskId: string, name: string): string {
  const started = database.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskId,
    startOptions: {}
  })
  database.prepareStartingWorkerAuthority({
    dispatchId: started.dispatch.id,
    handle: `term_${name}`,
    paneKey: `tab_${name}:aaaaaaaa-aaaa-4aaa-8aaa-${name.length.toString(16).padStart(12, '0')}`,
    processIncarnation: `${name}:1`,
    worktreeId: `repo::${name}`,
    effects: [],
    setupState: 'not_applicable',
    terminalOwnership: 'created'
  })
  database.markWorkerDispatchReady(started.dispatch.id)
  return started.dispatch.id
}

describe('lifecycle graph against its callers', () => {
  it('settles a stopping worker whose PTY exits during the stop', () => {
    const database = createDatabase()
    const task = database.createTask({
      runId: 'run_legacy_local',
      spec: 'stopping exited worker'
    })
    const dispatchId = startWorker(database, task.id, 'stopping_exited')

    expect(database.beginWorkerStop(dispatchId, 'runtime_test').disposition).toBe('stopping')
    expect(database.getWorkerDispatch(dispatchId)?.state).toBe('stopping')

    expect(() =>
      database.failDispatch(dispatchId, 'process exited', {
        workerProcessExited: true,
        terminationReason: 'exited'
      })
    ).not.toThrow()
    expect(database.getWorkerDispatch(dispatchId)?.state).toBe('failed')
  })
})
