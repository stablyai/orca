import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import { createRootDispatch } from '../root-dispatch-test-fixture'

describe('verifyDispatchCapability', () => {
  let db: OrchestrationDb

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
  })

  afterEach(() => {
    db.close()
  })

  function mintedWorker() {
    const run = db.createRun({
      objective: 'capability guidance',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    const task = db.createTask({ spec: 'work', runId: run.id })
    const paneKey = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const dispatch = createRootDispatch(db, task.id, 'term_worker', paneKey)
    const capability = db.mintDispatchCapability({
      dispatchId: dispatch.id,
      paneKey,
      processIncarnation: 'worker:1'
    })
    return { dispatchId: dispatch.id, paneKey, capability }
  }

  // Why: the caller that hits this is an agent reading only the error string, so it must name the flag.
  it('names the flag that supplies a missing capability', () => {
    const worker = mintedWorker()

    const result = db.verifyDispatchCapability({
      dispatchId: worker.dispatchId,
      capability: undefined,
      paneKey: worker.paneKey,
      processIncarnation: 'worker:1'
    })

    expect(result).toMatchObject({ valid: false })
    expect(result.valid === false && result.reason).toContain('--dispatch-capability')
  })

  it('still accepts the minted capability', () => {
    const worker = mintedWorker()

    expect(
      db.verifyDispatchCapability({
        dispatchId: worker.dispatchId,
        capability: worker.capability,
        paneKey: worker.paneKey,
        processIncarnation: 'worker:1'
      })
    ).toEqual({ valid: true })
  })
})
