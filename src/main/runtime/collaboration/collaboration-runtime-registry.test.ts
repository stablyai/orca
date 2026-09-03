import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration/db'
import { OrcaRuntimeService } from '../orca-runtime'
import type { CollaborationTopology } from './collaboration-topology'
import {
  getCollaborationRuntimeTopology,
  registerCollaborationRuntimeTopology,
  unregisterCollaborationRuntimeTopology
} from './collaboration-runtime-registry'

function topology(taskId: string): CollaborationTopology {
  return { steps: [{ taskId }] }
}

type Harness = {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  runId: string
}

describe('collaboration-runtime-registry', () => {
  const opened: OrchestrationDb[] = []

  function createHarness(dbPath: string = ':memory:'): Harness {
    const db = new OrchestrationDb(dbPath)
    opened.push(db)
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const run = db.createRun({
      objective: 'collaboration registry test',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: `tab_coord:${crypto.randomUUID()}`
    })
    return { runtime, db, runId: run.id }
  }

  afterEach(() => {
    while (opened.length > 0) {
      opened.pop()?.close()
    }
  })

  it('round-trips the registered topology without mutating the caller value', () => {
    const { runtime, runId } = createHarness()
    const value: CollaborationTopology = {
      steps: [
        {
          taskId: 't1',
          subscribesTo: ['topic-a'],
          admission: { acceptedTypes: ['finding'], minPriority: 'normal' }
        }
      ]
    }

    registerCollaborationRuntimeTopology(runtime, runId, value)

    expect(getCollaborationRuntimeTopology(runtime, runId)).toEqual(value)
    expect(value).toEqual({
      steps: [
        {
          taskId: 't1',
          subscribesTo: ['topic-a'],
          admission: { acceptedTypes: ['finding'], minPriority: 'normal' }
        }
      ]
    })
  })

  it('rejects duplicate registration of the same run', () => {
    const { runtime, runId } = createHarness()

    registerCollaborationRuntimeTopology(runtime, runId, topology('t1'))

    expect(() => registerCollaborationRuntimeTopology(runtime, runId, topology('t2'))).toThrow(
      /already registered/i
    )
  })

  it('returns undefined for an unknown or unconfigured run', () => {
    const { runtime, runId } = createHarness()

    expect(getCollaborationRuntimeTopology(runtime, runId)).toBeUndefined()
    expect(getCollaborationRuntimeTopology(runtime, 'run-missing')).toBeUndefined()
  })

  it('unregisters a run', () => {
    const { runtime, runId } = createHarness()
    registerCollaborationRuntimeTopology(runtime, runId, topology('t1'))

    unregisterCollaborationRuntimeTopology(runtime, runId)

    expect(getCollaborationRuntimeTopology(runtime, runId)).toBeUndefined()
  })

  it('unregister is idempotent', () => {
    const { runtime, runId } = createHarness()

    unregisterCollaborationRuntimeTopology(runtime, runId)
    unregisterCollaborationRuntimeTopology(runtime, runId)

    expect(getCollaborationRuntimeTopology(runtime, runId)).toBeUndefined()
  })

  it('allows re-registering a run after unregister', () => {
    const { runtime, runId } = createHarness()

    registerCollaborationRuntimeTopology(runtime, runId, topology('t1'))
    unregisterCollaborationRuntimeTopology(runtime, runId)
    registerCollaborationRuntimeTopology(runtime, runId, topology('t2'))

    expect(getCollaborationRuntimeTopology(runtime, runId)).toEqual(topology('t2'))
  })

  it('persists a registration across runtime replacement on the same database', () => {
    const dbPath = join(
      mkdtempSync(join(tmpdir(), 'orca-collaboration-registry-')),
      'orchestration.db'
    )
    const first = createHarness(dbPath)
    registerCollaborationRuntimeTopology(first.runtime, first.runId, topology('persisted'))
    first.db.close()
    opened.splice(opened.indexOf(first.db), 1)

    const reopenedDb = new OrchestrationDb(dbPath)
    opened.push(reopenedDb)
    const restartedRuntime = new OrcaRuntimeService()
    restartedRuntime.setOrchestrationDb(reopenedDb)

    expect(getCollaborationRuntimeTopology(restartedRuntime, first.runId)).toEqual(
      topology('persisted')
    )
  })

  it('fails closed when persisted collaboration topology is corrupt', () => {
    const { runtime, db, runId } = createHarness()
    db.setRunCollaborationTopology(runId, '{"version":1,"steps":"not-an-array"}')

    let thrown: unknown
    try {
      getCollaborationRuntimeTopology(runtime, runId)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toMatchObject({ code: 'collaboration_topology_unavailable' })
  })

  it('deletes persisted topology when its Run is reset', () => {
    const { runtime, db, runId } = createHarness()
    registerCollaborationRuntimeTopology(runtime, runId, topology('t1'))

    db.resetAll()

    expect(db.getRunCollaborationTopology(runId)).toBeUndefined()
    expect(getCollaborationRuntimeTopology(runtime, runId)).toBeUndefined()
  })

  it('isolates registrations stored in different orchestration databases', () => {
    const runtimeA = createHarness()
    const runtimeB = createHarness()

    registerCollaborationRuntimeTopology(runtimeA.runtime, runtimeA.runId, topology('a'))
    registerCollaborationRuntimeTopology(runtimeB.runtime, runtimeB.runId, topology('b'))

    expect(getCollaborationRuntimeTopology(runtimeA.runtime, runtimeA.runId)).toEqual(topology('a'))
    expect(getCollaborationRuntimeTopology(runtimeB.runtime, runtimeB.runId)).toEqual(topology('b'))
    expect(getCollaborationRuntimeTopology(runtimeB.runtime, runtimeA.runId)).toBeUndefined()
  })
})
