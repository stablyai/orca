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
  })
}
