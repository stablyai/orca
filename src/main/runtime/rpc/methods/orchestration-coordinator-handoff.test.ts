import { afterEach, describe, expect, it } from 'vitest'
import { createOrchestrationRpcHarness } from './orchestration/rpc-test-harness'

describe('orchestration coordinator handoff RPC', () => {
  const harness = createOrchestrationRpcHarness()

  afterEach(() => harness.cleanup())

  it('returns the durable receipt without replaying launch effects', async () => {
    const { db, ctx, activeRunId } = harness.setup()
    const run = db.getRun(activeRunId as string)!
    db.reserveCoordinatorHandoff({
      requestId: 'handoff:show',
      runId: run.id,
      executionHostId: 'local',
      workspaceKey: 'folder:one',
      title: 'Harness · coordinator g2 · Codex',
      launchProfile: {
        agent: 'codex',
        model: null,
        effort: null,
        permissionMode: 'yolo',
        routeRef: null
      },
      spawnedBy: 'coordinator:g1',
      ownerPrincipal: 'coordinator:g2',
      capsuleDigest: `sha256:${'a'.repeat(64)}`,
      inputIdempotencyKey: 'handoff:show:input',
      expectedGraphRevision: 1,
      retentionPolicy: 'retain'
    })

    const result = (await harness.call(
      'orchestration.coordinatorHandoff',
      { operation: 'show', requestId: 'handoff:show' },
      ctx
    )) as { handoff: { requestId: string; phase: string } }

    expect(result.handoff).toMatchObject({ requestId: 'handoff:show', phase: 'reserved' })
  })
})
