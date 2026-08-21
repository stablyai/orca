import { afterEach, describe, expect, it } from 'vitest'
import {
  cleanupLegacyCompatibilityDispatcherHarnesses,
  COORDINATOR_HANDLE,
  createHarness,
  currentEvidence,
  CURRENT_COORDINATOR_HANDLE,
  CURRENT_COORDINATOR_PANE,
  evidence,
  invoke,
  request,
  type LegacyCompatibilityDispatcherHarness
} from '../orchestration-legacy-compatibility-dispatcher-test-fixture'

const STRANGER_HANDLE = 'term_stranger_coord'
const STRANGER_PANE = 'tab_stranger:77777777-7777-4777-8777-777777777777'

afterEach(() => {
  cleanupLegacyCompatibilityDispatcherHarnesses()
})

function bindCurrentCoordinatorRun(harness: LegacyCompatibilityDispatcherHarness): string {
  return harness.db.createRun({
    objective: 'current work',
    coordinatorHandle: CURRENT_COORDINATOR_HANDLE,
    coordinatorPaneKey: CURRENT_COORDINATOR_PANE
  }).id
}

// Why: the adopted Run's recovered task is the cross-Run target; its dispatch must stay live when a gate is refused.
function adoptedTaskState(harness: LegacyCompatibilityDispatcherHarness) {
  return {
    task: harness.db.getTask(harness.taskId)?.status,
    dispatch: harness.db.getDispatchContextById(harness.dispatchId)?.status,
    gates: harness.db.listGates({ taskId: harness.taskId }).length
  }
}

const UNATTESTED_CURRENT_COORDINATOR = { ...currentEvidence('coordinator'), launchToken: '' }

describe('orchestration gate Run authorization', () => {
  it.each(['dispatch', 'websocket'] as const)(
    'G1 %s refuses an unbound attested caller creating a gate on the adopted Run',
    async (transport) => {
      const harness = createHarness()
      const before = adoptedTaskState(harness)

      const response = await invoke(
        harness.dispatcher,
        request(
          'orchestration.gateCreate',
          { task: harness.taskId, question: 'Proceed?' },
          currentEvidence('coordinator'),
          `g1-unbound-gate-create-${transport}`
        ),
        transport
      )

      expect(response).toMatchObject({ ok: false, error: { code: 'run_required' } })
      expect(adoptedTaskState(harness)).toEqual(before)
    }
  )

  it('G2 refuses an unattested caller creating a gate on another Run task', async () => {
    const harness = createHarness()
    const runA = bindCurrentCoordinatorRun(harness)
    const before = adoptedTaskState(harness)

    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.gateCreate',
        { task: harness.taskId, question: 'Proceed?', from: CURRENT_COORDINATOR_HANDLE },
        UNATTESTED_CURRENT_COORDINATOR,
        'g2-cross-run-gate-create'
      )
    )

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'task_not_found',
        message: `Task ${harness.taskId} was not found in Run ${runA}.`
      }
    })
    expect(adoptedTaskState(harness)).toEqual(before)
  })

  it('G2 refuses the same caller when it names no sender terminal at all', async () => {
    const harness = createHarness()
    bindCurrentCoordinatorRun(harness)
    const before = adoptedTaskState(harness)

    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.gateCreate',
        { task: harness.taskId, question: 'Proceed?' },
        UNATTESTED_CURRENT_COORDINATOR,
        'g2-anonymous-gate-create'
      )
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'run_required' } })
    expect(adoptedTaskState(harness)).toEqual(before)
  })

  it('G3 refuses an unattested caller once the adopted Run is claimed', async () => {
    const harness = createHarness()
    const claim = await harness.dispatcher.dispatch(
      request(
        'orchestration.runUse',
        { id: harness.adoptedRunId, from: COORDINATOR_HANDLE },
        evidence('coordinator'),
        'g3-legacy-claim'
      )
    )
    expect(claim).toMatchObject({ ok: true })
    bindCurrentCoordinatorRun(harness)
    const before = adoptedTaskState(harness)

    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.gateCreate',
        { task: harness.taskId, question: 'Proceed?', from: CURRENT_COORDINATOR_HANDLE },
        UNATTESTED_CURRENT_COORDINATOR,
        'g3-claimed-gate-create'
      )
    )

    expect(response).toMatchObject({ ok: false })
    expect(adoptedTaskState(harness)).toEqual(before)
  })

  it('G4 refuses an attested bound caller creating a gate in a stranger Run', async () => {
    const harness = createHarness()
    const runA = bindCurrentCoordinatorRun(harness)
    const strangerRun = harness.db.createRun({
      objective: 'stranger work',
      coordinatorHandle: STRANGER_HANDLE,
      coordinatorPaneKey: STRANGER_PANE
    })
    const strangerTask = harness.db.createTask({
      spec: 'stranger assignment',
      runId: strangerRun.id
    })

    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.gateCreate',
        { task: strangerTask.id, question: 'Proceed?', from: CURRENT_COORDINATOR_HANDLE },
        currentEvidence('coordinator'),
        'g4-stranger-gate-create'
      )
    )

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'task_not_found',
        message: `Task ${strangerTask.id} was not found in Run ${runA}.`
      }
    })
    expect(harness.db.getTask(strangerTask.id)?.status).toBe('ready')
    expect(harness.db.listGates({ taskId: strangerTask.id })).toHaveLength(0)
  })

  it('G4 refuses the stranger Run even when it is named explicitly', async () => {
    const harness = createHarness()
    const runA = bindCurrentCoordinatorRun(harness)
    const strangerRun = harness.db.createRun({
      objective: 'stranger work',
      coordinatorHandle: STRANGER_HANDLE,
      coordinatorPaneKey: STRANGER_PANE
    })
    const strangerTask = harness.db.createTask({
      spec: 'stranger assignment',
      runId: strangerRun.id
    })

    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.gateCreate',
        {
          task: strangerTask.id,
          question: 'Proceed?',
          from: CURRENT_COORDINATOR_HANDLE,
          run: strangerRun.id
        },
        currentEvidence('coordinator'),
        'g4-explicit-stranger-gate-create'
      )
    )

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'consumer_fenced',
        message: `This coordinator terminal is bound to ${runA}, not ${strangerRun.id}.`
      }
    })
    expect(harness.db.getTask(strangerTask.id)?.status).toBe('ready')
  })

  it('G5 refuses an unattested caller resolving another Run gate', async () => {
    const harness = createHarness()
    bindCurrentCoordinatorRun(harness)
    const gate = harness.db.createGate({ taskId: harness.taskId, question: 'Proceed?' })

    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.gateResolve',
        { id: gate.id, resolution: 'yes', from: CURRENT_COORDINATOR_HANDLE },
        UNATTESTED_CURRENT_COORDINATOR,
        'g5-cross-run-gate-resolve'
      )
    )

    expect(response).toMatchObject({ ok: false, error: { message: `Gate not found: ${gate.id}` } })
    expect(harness.db.getGate(gate.id)?.status).toBe('pending')
    expect(harness.db.getTask(harness.taskId)?.status).toBe('blocked')
  })

  it('keeps gate-list from leaking gates outside the caller Run', async () => {
    const harness = createHarness()
    const runA = bindCurrentCoordinatorRun(harness)
    const ownTask = harness.db.createTask({ spec: 'own assignment', runId: runA })
    const ownGate = harness.db.createGate({ taskId: ownTask.id, question: 'Own?' })
    harness.db.createGate({ taskId: harness.taskId, question: 'Adopted?' })

    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.gateList',
        { from: CURRENT_COORDINATOR_HANDLE },
        currentEvidence('coordinator'),
        'gate-list-scope'
      )
    )

    expect(response).toMatchObject({
      ok: true,
      result: { runId: runA, count: 1, gates: [{ id: ownGate.id }] }
    })
  })

  it('lets the bound coordinator create, list, and resolve its own Run gates', async () => {
    const harness = createHarness()
    const runA = bindCurrentCoordinatorRun(harness)
    const ownTask = harness.db.createTask({ spec: 'own assignment', runId: runA })

    const created = (await harness.dispatcher.dispatch(
      request(
        'orchestration.gateCreate',
        {
          task: ownTask.id,
          question: 'Ship it?',
          options: JSON.stringify(['yes', 'no']),
          from: CURRENT_COORDINATOR_HANDLE
        },
        currentEvidence('coordinator'),
        'own-gate-create'
      )
    )) as { ok: true; result: { gate: { id: string } } }

    expect(created).toMatchObject({ ok: true, result: { gate: { task_id: ownTask.id } } })
    expect(harness.db.getTask(ownTask.id)?.status).toBe('blocked')

    const resolved = await harness.dispatcher.dispatch(
      request(
        'orchestration.gateResolve',
        {
          id: created.result.gate.id,
          resolution: 'yes',
          from: CURRENT_COORDINATOR_HANDLE
        },
        currentEvidence('coordinator'),
        'own-gate-resolve'
      )
    )

    expect(resolved).toMatchObject({
      ok: true,
      result: { gate: { status: 'resolved', resolution: 'yes' } }
    })
    expect(harness.db.getTask(ownTask.id)?.status).toBe('ready')
  })

  it('keeps the retained legacy coordinator operating on the adopted Run', async () => {
    const harness = createHarness()

    const created = (await harness.dispatcher.dispatch(
      request(
        'orchestration.gateCreate',
        { task: harness.taskId, question: 'Proceed?', from: COORDINATOR_HANDLE },
        evidence('coordinator'),
        'legacy-gate-create'
      )
    )) as { ok: true; result: { gate: { id: string; run_id: string } } }

    expect(created).toMatchObject({
      ok: true,
      result: { gate: { task_id: harness.taskId, run_id: harness.adoptedRunId } }
    })

    const resolved = await harness.dispatcher.dispatch(
      request(
        'orchestration.gateResolve',
        { id: created.result.gate.id, resolution: 'go', from: COORDINATOR_HANDLE },
        evidence('coordinator'),
        'legacy-gate-resolve'
      )
    )

    expect(resolved).toMatchObject({ ok: true, result: { gate: { status: 'resolved' } } })
    expect(harness.db.getTask(harness.taskId)?.status).toBe('ready')
  })
})
