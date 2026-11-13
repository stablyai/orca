import { afterEach, describe, expect, it } from 'vitest'
import { createOrchestrationWorkerReleaseHarness } from '../testing/worker-release.test-support'

export function registerWorkerReleaseInventoryTests(): void {
  describe('orchestration worker release inventory', () => {
    const h = createOrchestrationWorkerReleaseHarness()

    afterEach(() => h.cleanup())

    it('rejects exact reuse after release intent instead of closing the new worker', async () => {
      h.setup()
      const first = await h.startSettledWorker('succeeded')
      expect(h.db.requestWorkerTerminalRelease(first.dispatchId).disposition).toBe('requested')
      const nextTask = h.db.createTask({ spec: 'racing reuse', runId: h.activeRunId })

      const attempted = (await h.call('orchestration.workerStart', {
        task: nextTask.id,
        from: 'term_coord',
        terminal: 'term_worker'
      })) as { state: string; lastError?: string }

      expect(attempted).toMatchObject({ state: 'failed' })
      expect(attempted.lastError).toMatch(/release.*progress/i)
      expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
      await expect(
        h.call('orchestration.workerRelease', { dispatch: first.dispatchId })
      ).resolves.toMatchObject({ state: 'released' })
      expect(h.runtime.closeTerminal).toHaveBeenCalledTimes(1)
    })

    it('reports abandoned workers as retained instead of reclaimable', async () => {
      h.setup()
      const { dispatchId } = await h.startWorker()
      await h.call('orchestration.workerAbandon', { dispatch: dispatchId })

      const listed = (await h.call('orchestration.workerList', { run: h.activeRunId })) as {
        workers: { dispatchId: string; terminalState: string | null }[]
      }

      expect(listed.workers).toContainEqual(
        expect.objectContaining({ dispatchId, terminalState: 'retained' })
      )
      await expect(
        h.call('orchestration.workerRelease', { dispatch: dispatchId })
      ).resolves.toMatchObject({
        state: 'retained',
        reason: 'identity_unproven',
        processAction: 'none'
      })
      expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
    })
  })
}
