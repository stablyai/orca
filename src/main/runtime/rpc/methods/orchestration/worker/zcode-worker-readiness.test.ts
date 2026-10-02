import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalWait } from '../../../../../../shared/runtime-types'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'

describe('composer-marker first dispatch readiness', () => {
  const h = createOrchestrationWorkerReleaseHarness()
  afterEach(() => h.cleanup())

  // DSH's idle hook fires only after a turn, and Grok's only other signal is its bare name, which a
  // shell auto-title also writes; like ZCode, their captured composer is their readiness.
  it.each(['zcode', 'dsh', 'grok'] as const)(
    'waits for %s’s new composer before delivering exactly one dispatch',
    async (agent) => {
      h.setup()
      // The paste path: a host whose line cannot carry the brief leaves it for after readiness.
      h.leaveBriefForPaste()
      const gate = h.deferred<RuntimeTerminalWait>()
      vi.spyOn(h.runtime, 'waitForFreshWorkerComposer').mockReturnValue(gate.promise)
      const pending = h.startWorker({ agent })
      await vi.waitFor(() =>
        expect(h.runtime.waitForFreshWorkerComposer).toHaveBeenCalledWith(
          'term_worker',
          agent,
          60_000,
          expect.anything()
        )
      )
      expect(h.runtime.waitForTerminal).not.toHaveBeenCalled()
      expect(h.runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
      gate.resolve({
        handle: 'term_worker',
        condition: 'tui-idle',
        satisfied: true,
        status: 'running',
        exitCode: null
      })
      await pending
      expect(h.runtime.sendTerminalAgentPrompt).toHaveBeenCalledOnce()
    }
  )

  it('keeps reused terminals on the normal idle wait', async () => {
    h.setup()
    vi.spyOn(h.runtime, 'waitForFreshWorkerComposer')
    await h.startWorker({ terminal: 'term_worker' })
    expect(h.runtime.waitForFreshWorkerComposer).not.toHaveBeenCalled()
    expect(h.runtime.waitForTerminal).toHaveBeenCalledWith(
      'term_worker',
      expect.objectContaining({ condition: 'tui-idle' })
    )
  })

  it('never delivers a task after a startup timeout', async () => {
    h.setup()
    vi.spyOn(h.runtime, 'waitForFreshWorkerComposer').mockRejectedValue(new Error('timeout'))
    await expect(h.startWorker({ agent: 'zcode' })).rejects.toThrow('Expected worker-start')
    expect(h.runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })
})
