import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../db'

describe('federated Dispatch observation fence', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  it('rejects out-of-order epochs and observations captured before release', () => {
    const database = (db = new OrchestrationDb(':memory:'))
    const task = database.createTask({ spec: 'fenced federated observation' })
    const started = database.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {},
      federation: {
        environmentId: 'environment-worker',
        environmentName: 'worker',
        peerFingerprint: 'peer-worker',
        protocolVersion: 3
      }
    })
    database.reconcileFederatedWorkerStart({
      dispatchId: started.dispatch.id,
      state: 'ready',
      stage: 'remote_input_accepted',
      worktreeId: 'repo::remote',
      terminalHandle: 'term_remote'
    })
    database.updateFederatedDispatchResources({
      dispatchId: started.dispatch.id,
      remoteRuntimeEpoch: 'epoch-1',
      worktreeId: 'repo::remote',
      terminalHandle: 'term_remote'
    })

    const oldEpochFence = database.captureFederatedDispatchObservationFence(started.dispatch.id)!
    expect(
      database.projectFederatedDispatchObservation(oldEpochFence, () => {
        database.updateFederatedDispatchRuntimeEpoch(started.dispatch.id, 'epoch-2')
      })
    ).toBe(true)
    expect(
      database.projectFederatedDispatchObservation(oldEpochFence, () => {
        database.updateFederatedDispatchRuntimeEpoch(started.dispatch.id, 'epoch-1')
      })
    ).toBe(false)
    expect(database.getFederatedDispatch(started.dispatch.id)?.remote_runtime_epoch).toBe('epoch-2')

    const beforeRelease = database.captureFederatedDispatchObservationFence(started.dispatch.id)!
    database.transitionLifecycle({
      entity: 'worker',
      id: started.dispatch.id,
      from: 'ready',
      to: 'ready',
      projection: { stage: 'released', agent_terminal_handle: null }
    })
    database.db
      .prepare(
        'UPDATE federated_dispatches SET remote_terminal_handle = NULL WHERE dispatch_id = ?'
      )
      .run(started.dispatch.id)

    expect(
      database.projectFederatedDispatchObservation(beforeRelease, () => {
        database.recordWorkerStage({
          dispatchId: started.dispatch.id,
          stage: 'remote_input_accepted',
          terminalHandle: 'term_remote'
        })
        database.updateFederatedDispatchResources({
          dispatchId: started.dispatch.id,
          remoteRuntimeEpoch: 'epoch-2',
          worktreeId: 'repo::remote',
          terminalHandle: 'term_remote'
        })
      })
    ).toBe(false)
    expect(database.getWorkerDispatch(started.dispatch.id)).toMatchObject({
      stage: 'released',
      agent_terminal_handle: null
    })
    expect(database.getFederatedDispatch(started.dispatch.id)?.remote_terminal_handle).toBeNull()
  })
})
