import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalWait } from '../../../../../../shared/runtime-terminal-contracts'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'

const COMPOSER_READY: RuntimeTerminalWait = {
  handle: 'term_worker',
  condition: 'tui-idle',
  satisfied: true,
  status: 'running',
  exitCode: null
}

describe('first dispatch readiness of a freshly launched worker', () => {
  const h = createOrchestrationWorkerReleaseHarness()
  afterEach(() => h.cleanup())

  it.each(['zcode', 'opencode', 'opencode2'] as const)(
    '%s waits for its input box before delivering exactly one dispatch',
    async (agent) => {
      h.setup()
      const gate = h.deferred<RuntimeTerminalWait>()
      vi.spyOn(h.runtime, 'waitForFreshWorkerComposer').mockReturnValue(gate.promise)
      const pending = h.startWorker({ agent })
      await vi.waitFor(() =>
        expect(h.runtime.waitForFreshWorkerComposer).toHaveBeenCalledWith(
          'term_worker',
          agent,
          60_000
        )
      )
      expect(h.runtime.waitForTerminal).not.toHaveBeenCalled()
      expect(h.runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
      gate.resolve(COMPOSER_READY)
      await pending
      expect(h.runtime.sendTerminalAgentPrompt).toHaveBeenCalledOnce()
      expect(h.runtime.sendTerminalAgentPrompt).toHaveBeenCalledWith(
        'term_worker',
        expect.any(String),
        expect.objectContaining({ retrySubmitAfterLaunch: true })
      )
    }
  )

  it.each(['codex', 'claude', 'grok', 'mimo-code'] as const)(
    '%s, with no captured input-box marker, keeps the tui-idle wait',
    async (agent) => {
      h.setup()
      vi.spyOn(h.runtime, 'waitForFreshWorkerComposer')
      await h.startWorker({ agent })
      expect(h.runtime.waitForFreshWorkerComposer).not.toHaveBeenCalled()
      expect(h.runtime.waitForTerminal).toHaveBeenCalledWith(
        'term_worker',
        expect.objectContaining({ condition: 'tui-idle' })
      )
    }
  )

  it('keeps reused terminals on the normal idle wait', async () => {
    h.setup()
    vi.spyOn(h.runtime, 'waitForFreshWorkerComposer')
    await h.startWorker({ terminal: 'term_worker' })
    expect(h.runtime.waitForFreshWorkerComposer).not.toHaveBeenCalled()
    expect(h.runtime.sendTerminalAgentPrompt).toHaveBeenCalledWith(
      'term_worker',
      expect.any(String),
      expect.objectContaining({ retrySubmitAfterLaunch: false })
    )
    expect(h.runtime.waitForTerminal).toHaveBeenCalledWith(
      'term_worker',
      expect.objectContaining({ condition: 'tui-idle' })
    )
  })

  it.each(['zcode', 'opencode'] as const)(
    '%s never delivers a task after a startup timeout',
    async (agent) => {
      h.setup()
      vi.spyOn(h.runtime, 'waitForFreshWorkerComposer').mockRejectedValue(new Error('timeout'))
      await expect(h.startWorker({ agent })).rejects.toThrow('Expected worker-start')
      expect(h.runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
    }
  )
})
