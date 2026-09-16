import { afterEach, describe, expect, it } from 'vitest'
import type { OrchestrationFleetWorker } from '../../../../../../shared/orchestration-fleet-projection'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'

type ReadWithProjection = { projection?: OrchestrationFleetWorker | null }

describe('orchestration worker-read fleet projection', () => {
  const h = createOrchestrationWorkerReleaseHarness()

  afterEach(() => h.cleanup())

  it('publishes the fleet agent verdict beside the PTY verdict on a live read', async () => {
    h.setup()
    const { dispatchId } = await h.startWorker()

    const read = (await h.call('orchestration.workerRead', {
      dispatch: dispatchId
    })) as ReadWithProjection & { status: { liveness?: string } }

    expect(read.projection?.dispatchId).toBe(dispatchId)
    // The agent verdict is not the PTY verdict; worker-read must carry both.
    expect(read.status.liveness).toBe('live')
    expect(read.projection?.liveness.verdict).toBe('unverifiable')
  })

  it('carries the projection on an archived read after release', async () => {
    h.setup()
    const { dispatchId } = await h.startSettledWorker()
    await h.call('orchestration.workerRelease', { dispatch: dispatchId })

    const read = (await h.call('orchestration.workerRead', {
      dispatch: dispatchId
    })) as ReadWithProjection

    expect(read.projection?.dispatchId).toBe(dispatchId)
    expect(read.projection?.liveness.verdict).toBe('exited')
  })
})
