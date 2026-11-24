import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../../../../orchestration/db/orchestration-db'
import { WorkerStartParams } from '../../../../../../../shared/rpc-contract/orchestration/orchestration-worker-start-params'
import { exposeWorker } from '../observation/worker-observation'
import {
  assertWorkerAdditionalDirectoriesMode,
  assertWorkerLaunchPreferencesCreateTerminal
} from '../start/launch/worker-launch-preferences'
import { parseStartOptions } from './worker-earlier-work'

describe('worker start_options additionalDirectories round-trip', () => {
  let db: OrchestrationDb | undefined
  afterEach(() => {
    db?.close()
    db = undefined
  })

  it('persists, surfaces via exposeWorker, and parses additionalDirectories', () => {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'work',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: null
    })
    const task = db.createTask({ runId: run.id, spec: 'work' })
    const dirs = ['C:\\workspace\\shared', '/tmp/extra']
    const { worker } = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {
        agent: 'antigravity',
        additionalDirectories: dirs,
        launch: {
          requested: { agent: 'antigravity', model: 'gemini-3-pro', effort: 'high' },
          effective: null
        }
      }
    })

    const exposed = exposeWorker(worker)
    expect(exposed.startOptions).toMatchObject({
      agent: 'antigravity',
      additionalDirectories: dirs
    })
    expect(parseStartOptions(worker.start_options)).toEqual({
      agent: 'antigravity',
      model: 'gemini-3-pro',
      effort: 'high',
      additionalDirectories: dirs
    })
  })

  it('omits additionalDirectories when absent or empty and enforces WorkerStartParams bounds', () => {
    expect(
      parseStartOptions(JSON.stringify({ agent: 'antigravity', additionalDirectories: [] }))
    ).toEqual({
      agent: 'antigravity',
      model: undefined,
      effort: undefined
    })
    expect(
      WorkerStartParams.safeParse({
        spec: 'work',
        from: 'term_coord',
        additionalDirectories: ['/tmp/dir1', '/tmp/dir2']
      }).success
    ).toBe(true)
    expect(
      WorkerStartParams.safeParse({
        spec: 'work',
        from: 'term_coord',
        additionalDirectories: ['']
      }).success
    ).toBe(false)
    expect(
      WorkerStartParams.safeParse({
        spec: 'work',
        from: 'term_coord',
        additionalDirectories: Array.from({ length: 65 }, (_, index) => `/dir/${index}`)
      }).success
    ).toBe(false)
  })

  it('refuses --add-dir when launching or reusing a terminal worker', () => {
    expect(() => assertWorkerAdditionalDirectoriesMode(['/materials'], 'terminal')).toThrowError(
      /terminal/
    )
    expect(() =>
      assertWorkerLaunchPreferencesCreateTerminal({
        terminal: 'term_1',
        additionalDirectories: ['/materials']
      })
    ).toThrowError(/--add-dir/)
  })
})
