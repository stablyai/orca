import { afterEach, describe, expect, it } from 'vitest'
import type { OrchestrationCompatibilityEvidence } from '../../../shared/orchestration-compatibility-evidence'
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
} from './orchestration-legacy-compatibility-dispatcher-test-fixture'

afterEach(() => {
  cleanupLegacyCompatibilityDispatcherHarnesses()
})

function unattested(proof: OrchestrationCompatibilityEvidence): OrchestrationCompatibilityEvidence {
  return { ...proof, launchToken: '' }
}

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
  it('declines jurisdiction over an unbound stranger while the adopted Run is claimed', async () => {
    const harness = createHarness()
    await claimAdoptedRunAsLegacyCoordinator(harness)

    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.taskCreate',
        { spec: 'fresh assignment', callerTerminalHandle: CURRENT_COORDINATOR_HANDLE },
        currentEvidence('coordinator'),
        'claimed-stranger-task-create'
      )
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'run_required' } })
    expect(harness.db.listTasks({ runId: harness.adoptedRunId })).toHaveLength(1)
  })

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

  it('leaves a named adopted Run to the downstream consumer check instead of the fence', async () => {
    const harness = createHarness()
    await claimAdoptedRunAsLegacyCoordinator(harness)

    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.taskCreate',
        {
          spec: 'stranger assignment',
          run: harness.adoptedRunId,
          callerTerminalHandle: CURRENT_COORDINATOR_HANDLE
        },
        currentEvidence('coordinator'),
        'claimed-stranger-named-run-task-create'
      )
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'consumer_fenced' } })
    expect(harness.db.listTasks({ runId: harness.adoptedRunId })).toHaveLength(1)
  })

  it('still fences the legacy coordinator after its principal is revoked by a takeover', async () => {
    const harness = createHarness()
    await claimAdoptedRunAsLegacyCoordinator(harness)
    await takeoverAdoptedRun(harness)

    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.taskCreate',
        {
          spec: 'stale assignment',
          run: harness.adoptedRunId,
          callerTerminalHandle: COORDINATOR_HANDLE
        },
        evidence('coordinator'),
        'revoked-legacy-task-create'
      )
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'legacy_read_only' } })
    expect(harness.db.listTasks({ runId: harness.adoptedRunId })).toHaveLength(1)
  })

  it('lets the post-takeover owner operate the adopted Run without attestation', async () => {
    const harness = createHarness()
    await claimAdoptedRunAsLegacyCoordinator(harness)
    await takeoverAdoptedRun(harness)

    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.taskCreate',
        {
          spec: 'owner assignment',
          run: harness.adoptedRunId,
          callerTerminalHandle: CURRENT_COORDINATOR_HANDLE
        },
        unattested(currentEvidence('coordinator')),
        'owner-unattested-task-create'
      )
    )

    expect(response).toMatchObject({
      ok: true,
      result: { task: { run_id: harness.adoptedRunId, spec: 'owner assignment' } }
    })
  })
})
