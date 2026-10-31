import { expect, it } from 'vitest'
import { ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_PROTOCOL_VERSION } from '../../../shared/protocol-version'
import { testOrcaSessionId } from '../../../shared/orca-session-address-test-fixture'
import { acquiredAgentSessionAccount } from '../../../shared/agent-session-acquired-account'
import { hostTestOperationId } from './structured-agent-session-host-test-data'
import {
  createReceivingCallerFixture,
  HOME_A,
  HOME_B,
  PARENT
} from './structured-agent-session-receiving-callers.test-support'

const SUCCESSOR = testOrcaSessionId('2842b48e-8a73-443a-99fb-810bf7eb09ce')

it('routes an imported committed clear lineage to its current visible receiver, using its own successful receipt', async () => {
  const f = await createReceivingCallerFixture()
  try {
    await f.found()
    await f.ensure(SUCCESSOR)
    await f.rig.store.setSessionTabVisibility(SUCCESSOR, true)
    const db = f.runtime.getOrchestrationDb()
    const run = db.createRun({
      objective: 'lineage receiving work',
      coordinatorHandle: null,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: PARENT
    })
    db.createStartingWorkerDispatch({
      taskSpec: 'still owed to this conversation',
      taskRunId: run.id,
      creator: { kind: 'session', orcaSessionId: PARENT },
      maxDepth: 9,
      startOptions: {}
    })
    await f.rig.host.close(PARENT, 'evict')
    // Stored older clear shape, written through the real record owner; no caller admission is changed.
    await f.rig.store.transitionHandoff(PARENT, (record) => ({
      ...record,
      conversationCommand: {
        command: 'clear',
        state: 'completed',
        phase: 'committed',
        runtimeFence: record.lease.runtimeFence,
        callerKey: 'older-clear-client',
        operationId: hostTestOperationId(),
        replacementSessionId: SUCCESSOR
      }
    }))
    await f.rig.store.setSessionTabVisibility(PARENT, false)
    f.selectB()
    expect(f.runtime.mailTarget(`run:${run.id}`)?.sessionId).toBe(SUCCESSOR)
    expect(await f.rig.host.prospectiveAccountHome(PARENT)).toEqual(HOME_B)
    expect(await f.rig.host.prospectiveAccountHome(SUCCESSOR)).toEqual(HOME_A)
    const parent = acquiredAgentSessionAccount(f.rig.store.requireWritableRecord(PARENT))
    const successor = acquiredAgentSessionAccount(f.rig.store.requireWritableRecord(SUCCESSOR))
    expect(successor?.generation).not.toBe(parent?.generation)
    await f.rig.host.close(SUCCESSOR, 'evict')
    await f.rig.store.setSessionTabVisibility(SUCCESSOR, false)
    expect(f.runtime.mailTarget(`run:${run.id}`)).toBeNull()
    expect(await f.rig.host.prospectiveAccountHome(SUCCESSOR)).toEqual(HOME_B)
  } finally {
    await f.dispose()
  }
})

it('a real root-remote relay import transfers pre-notice work into the home current mailbox', async () => {
  const f = await createReceivingCallerFixture()
  try {
    await f.found()
    const db = f.runtime.getOrchestrationDb()
    const run = db.createRun({
      objective: 'remote root result',
      coordinatorHandle: null,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: PARENT
    })
    f.runtime.stopOrchestrationFederationRelay()
    const worker = db.createStartingWorkerDispatch({
      taskSpec: 'remote work',
      taskRunId: run.id,
      creator: { kind: 'session', orcaSessionId: PARENT },
      maxDepth: 9,
      startOptions: {},
      federation: {
        environmentId: 'remote-environment',
        environmentName: 'paired worker',
        peerFingerprint: 'fixture-peer',
        protocolVersion: ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_PROTOCOL_VERSION
      }
    })
    f.selectB()
    expect(f.runtime.mailTarget(`run:${run.id}`)?.sessionId).toBe(PARENT)
    expect(await f.rig.host.prospectiveAccountHome(PARENT)).toEqual(HOME_A)
    const imported = db.importFederatedRelayItem({
      dispatchId: worker.dispatch.id,
      sequence: 1,
      message: {
        id: 'relay_root_result',
        runId: run.id,
        from: `dispatch:${worker.dispatch.id}`,
        to: `run:${run.id}`,
        subject: 'complete',
        body: 'real relay input',
        type: 'worker_done',
        priority: 'normal',
        payload: JSON.stringify({
          taskId: worker.task.id,
          dispatchId: worker.dispatch.id,
          outcome: 'succeeded'
        })
      },
      lifecycle: {
        kind: 'worker_report',
        taskId: worker.task.id,
        outcome: 'succeeded',
        result: 'complete'
      }
    })
    expect(imported.lifecycle).toMatchObject({ action: 'settled', outcome: 'succeeded' })
    expect(db.getMessageById(imported.message.id)?.to_handle).toBe(`run:${run.id}`)
    expect(await f.rig.host.prospectiveAccountHome(PARENT)).toEqual(HOME_A)
    db.markAsRead([imported.message.id])
    expect(await f.rig.host.prospectiveAccountHome(PARENT)).toEqual(HOME_B)
  } finally {
    await f.dispose()
  }
})
