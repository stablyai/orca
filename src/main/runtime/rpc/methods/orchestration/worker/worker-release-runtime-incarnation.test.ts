import { afterEach, describe, expect, it, vi } from 'vitest'
import { inspectWorkerTerminal } from './worker-observation'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'
import { makePaneKey } from '../../../../../../shared/stable-pane-id'

const PTY_ID = 'runtime_test:term_worker'
const LEAF_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

describe('worker release through runtime incarnation recovery', () => {
  const harness = createOrchestrationWorkerReleaseHarness()
  afterEach(() => harness.cleanup())

  it.each(['release', 'stop', 'read', 'replacement', 'disconnected'] as const)(
    '%s uses runtime identity and close paths',
    async (scenario) => {
      harness.setup()
      const { dispatchId } =
        scenario === 'stop' ? await harness.startWorker() : await harness.startSettledWorker()
      const runtime = harness.runtime
      vi.mocked(runtime.showTerminal).mockRestore()
      vi.mocked(runtime.getTerminalPaneKey).mockRestore()
      vi.mocked(runtime.getTerminalProcessIncarnation).mockRestore()
      vi.mocked(runtime.getOrchestrationDispatchAuthority).mockRestore()
      vi.mocked(runtime.readTerminal).mockRestore()
      vi.mocked(runtime.closeTerminal).mockRestore()
      const kill = vi.fn(() => true)
      runtime.setPtyController({ write: () => true, kill, getForegroundProcess: async () => null })
      runtime.registerPty(PTY_ID, 'repo::worktree', null, {
        tabId: 'tab_worker',
        leafId: LEAF_ID,
        incarnationId: scenario === 'replacement' ? '2' : '1'
      })
      await expect(runtime.showTerminal('term_worker')).rejects.toThrow()
      if (scenario === 'disconnected') {
        vi.spyOn(runtime, 'getTerminalLivenessVerdict').mockReturnValue({
          status: 'unverifiable',
          reason: 'transport unavailable'
        })
        const observed = await inspectWorkerTerminal(runtime, harness.db, dispatchId)
        expect(observed).toMatchObject({ exact: true, status: 'unverifiable' })
        expect(kill).not.toHaveBeenCalled()
        return
      }
      if (scenario === 'stop') {
        const receipt = await harness.call('orchestration.workerStop', { dispatch: dispatchId })
        expect(receipt).toMatchObject({ state: 'stopped', processAction: 'closed_agent_terminal' })
        expect(kill).toHaveBeenCalledExactlyOnceWith(PTY_ID)
        return
      }
      if (scenario === 'read') {
        const readTerminal = vi.spyOn(runtime, 'readTerminal')
        const output = await harness.call('orchestration.workerRead', { dispatch: dispatchId })
        // Pins the read to the reminted terminal: the handle it reached must resolve to the
        // registered pane and incarnation, which the stale durable handle never does.
        const [[readHandle]] = readTerminal.mock.calls
        expect(runtime.getTerminalPaneKey(readHandle)).toBe(makePaneKey('tab_worker', LEAF_ID))
        expect(runtime.getTerminalProcessIncarnation(readHandle)).toBe(`${PTY_ID}:1`)
        expect(output).toMatchObject({
          source: 'terminal',
          fallbackReason: 'session_not_reported'
        })
        expect(kill).not.toHaveBeenCalled()
        return
      }
      const receipt = await harness.call('orchestration.workerRelease', { dispatch: dispatchId })
      if (scenario === 'replacement') {
        expect(receipt).toMatchObject({ state: 'release_unknown', processAction: 'none' })
        expect(kill).not.toHaveBeenCalled()
        return
      }
      expect(receipt).toMatchObject({ state: 'released', processAction: 'closed_agent_terminal' })
      expect(kill).toHaveBeenCalledExactlyOnceWith(PTY_ID)
      expect(harness.db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
        ownership_state: 'released',
        release_state: 'released'
      })
    }
  )
})
