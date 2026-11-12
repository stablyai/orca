import { afterEach, describe, expect, it } from 'vitest'
import {
  cleanupLegacyCompatibilityDispatcherHarnesses,
  COORDINATOR_HANDLE,
  createHarness,
  currentEvidence,
  CURRENT_COORDINATOR_HANDLE,
  CURRENT_COORDINATOR_PANE,
  evidence,
  request,
  type LegacyCompatibilityDispatcherHarness
} from './testing/orchestration-legacy-compatibility-dispatcher-test-fixture'

afterEach(() => {
  cleanupLegacyCompatibilityDispatcherHarnesses()
})

async function claimAdoptedRunAsLegacyCoordinator(
  harness: LegacyCompatibilityDispatcherHarness
): Promise<void> {
  const response = await harness.dispatcher.dispatch(
    request(
      'orchestration.runUse',
      { id: harness.adoptedRunId, from: COORDINATOR_HANDLE },
      evidence('coordinator'),
      'legacy-coordinator-run-use'
    )
  )
  expect(response).toMatchObject({ ok: true })
  expect(harness.db.getLegacyCoordinatorPrincipal(harness.adoptedRunId)?.status).toBe('committed')
}

async function takeoverAdoptedRun(harness: LegacyCompatibilityDispatcherHarness): Promise<void> {
  const response = await harness.dispatcher.dispatch(
    request(
      'orchestration.runUse',
      { id: harness.adoptedRunId, from: CURRENT_COORDINATOR_HANDLE, takeoverLegacy: true },
      currentEvidence('coordinator'),
      'current-coordinator-takeover'
    )
  )
  expect(response).toMatchObject({ ok: true })
  expect(harness.db.getLegacyCoordinatorPrincipal(harness.adoptedRunId)?.status).toBe('revoked')
}

describe('legacy coordinator fence jurisdiction', () => {
  it('releases the fence once the adopted Run is unclaimed and its principal is revoked', async () => {
    const harness = createHarness()
    await claimAdoptedRunAsLegacyCoordinator(harness)
    await takeoverAdoptedRun(harness)
    // The new owner moves its pane to another Run, which unbinds the adopted Run.
    const elsewhere = harness.db.createRun({
      objective: 'other work',
      coordinatorHandle: CURRENT_COORDINATOR_HANDLE,
      coordinatorPaneKey: CURRENT_COORDINATOR_PANE
    })
    expect(elsewhere.id).not.toBe(harness.adoptedRunId)
    harness.db.bindRun({
      runId: elsewhere.id,
      coordinatorHandle: CURRENT_COORDINATOR_HANDLE,
      coordinatorPaneKey: CURRENT_COORDINATOR_PANE
    })
    expect(harness.db.getRun(harness.adoptedRunId)?.coordinator_pane_key).toBeNull()

    const fenced = await harness.dispatcher.dispatch(
      request(
        'orchestration.taskCreate',
        { spec: 'unclaimed assignment', callerTerminalHandle: COORDINATOR_HANDLE },
        evidence('coordinator'),
        'unclaimed-revoked-task-create'
      )
    )
    expect(fenced).toMatchObject({ ok: false, error: { code: 'run_required' } })

    const reclaim = await harness.dispatcher.dispatch(
      request(
        'orchestration.runUse',
        { id: harness.adoptedRunId, from: COORDINATOR_HANDLE },
        evidence('coordinator'),
        'unclaimed-revoked-run-use'
      )
    )
    // The Run still holds live legacy work, so the honest downstream error — not a dead-end fence — answers.
    expect(reclaim).toMatchObject({
      ok: false,
      error: {
        code: 'consumer_fenced',
        data: {
          recoveryCommand: `orca orchestration run-use --id ${harness.adoptedRunId} --takeover-legacy`
        }
      }
    })

    const recovered = await harness.dispatcher.dispatch(
      request(
        'orchestration.runUse',
        { id: harness.adoptedRunId, from: COORDINATOR_HANDLE, takeoverLegacy: true },
        evidence('coordinator'),
        'unclaimed-revoked-run-takeover'
      )
    )
    expect(recovered).toMatchObject({ ok: true, result: { run: { id: harness.adoptedRunId } } })
  })
})
