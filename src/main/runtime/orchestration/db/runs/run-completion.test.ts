import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import { createRootDispatch } from '../root-dispatch-test-fixture'

describe('Run completion persistence', () => {
  const directories: string[] = []
  const databases: OrchestrationDb[] = []

  afterEach(() => {
    for (const database of databases.splice(0)) {
      database.close()
    }
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('preserves the coordinator receipt and Task history after reopening', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-run-completion-'))
    const path = join(directory, 'orchestration.db')
    directories.push(directory)
    const database = new OrchestrationDb(path)
    const run = database.createRun({
      objective: 'Finish the Harness Run',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    })
    const task = database.createTask({ spec: 'Deferred review', runId: run.id })
    const attempt = createRootDispatch(database, task.id, 'term_worker')
    database.completeRun({
      runId: run.id,
      summary: 'Accepted the completed scope.',
      evidence: ['Focused suite passed.'],
      waivers: [{ task_id: task.id, reason: 'Deferred by the owner.' }],
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord',
      coordinatorGeneration: run.consumer_generation
    })
    database.close()

    const reopened = new OrchestrationDb(path)
    databases.push(reopened)

    expect(reopened.getRunCompletion(run.id)).toMatchObject({
      summary: 'Accepted the completed scope.',
      evidence: ['Focused suite passed.'],
      waivers: [{ task_id: task.id, reason: 'Deferred by the owner.' }],
      completed_by_handle: 'term_coord',
      completed_by_generation: run.consumer_generation
    })
    expect(reopened.getTask(task.id)).toMatchObject({ status: 'dispatched', result: null })
    expect(reopened.getDispatchContextById(attempt.id)).toMatchObject({
      task_id: task.id,
      status: 'dispatched'
    })
  })

  it('rejects empty evidence at the durable write boundary', () => {
    const database = new OrchestrationDb(':memory:')
    databases.push(database)
    const run = database.createRun({
      objective: 'Validate the receipt',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    })

    expect(() =>
      database.completeRun({
        runId: run.id,
        summary: 'No evidence supplied.',
        evidence: [],
        waivers: [],
        coordinatorHandle: 'term_coord',
        coordinatorPaneKey: 'tab_coord:leaf_coord',
        coordinatorGeneration: run.consumer_generation
      })
    ).toThrow(
      'Run completion requires a non-empty summary and at least one non-empty evidence item.'
    )
    expect(database.getRunCompletion(run.id)).toBeUndefined()
  })
})
