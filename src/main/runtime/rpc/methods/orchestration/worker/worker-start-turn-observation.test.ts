import { describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalPromptDelivery } from '../../../../../../shared/runtime-terminal-contracts'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { observeWorkerTurnStart } from './worker-start-turn-observation'

function delivery(
  overrides: Partial<RuntimeTerminalPromptDelivery> = {}
): RuntimeTerminalPromptDelivery {
  return {
    requestId: 'req-1',
    stages: ['input_accepted'],
    provider: 'codex',
    observation: 'supported',
    processIncarnation: 'inc-1',
    generation: 1,
    baselineWorkingSequence: 0,
    ...overrides
  }
}

function runtimeObserving(result: RuntimeTerminalPromptDelivery): {
  runtime: OrcaRuntimeService
  observe: ReturnType<typeof vi.fn>
} {
  const observe = vi.fn().mockResolvedValue(result)
  return {
    runtime: { observeTerminalAgentPrompt: observe } as unknown as OrcaRuntimeService,
    observe
  }
}

describe('observeWorkerTurnStart', () => {
  it('treats a missing receipt as unsupported observation, never as failure', async () => {
    const { runtime, observe } = runtimeObserving(delivery())
    await expect(
      observeWorkerTurnStart({ runtime, terminalHandle: 'term_w', prompt: undefined })
    ).resolves.toEqual({ verdict: 'unsupported' })
    expect(observe).not.toHaveBeenCalled()
  })

  it('accepts a first-stage turn_started without a second observation pass', async () => {
    const prompt = delivery({ stages: ['input_accepted', 'turn_started'] })
    const { runtime, observe } = runtimeObserving(prompt)
    await expect(
      observeWorkerTurnStart({ runtime, terminalHandle: 'term_w', prompt })
    ).resolves.toEqual({ verdict: 'observed', prompt })
    expect(observe).not.toHaveBeenCalled()
  })

  it('reports observed when the second-stage observer sees the turn start', async () => {
    const observed = delivery({ stages: ['input_accepted', 'turn_started'] })
    const { runtime, observe } = runtimeObserving(observed)
    await expect(
      observeWorkerTurnStart({
        runtime,
        terminalHandle: 'term_w',
        prompt: delivery(),
        timeoutMs: 5
      })
    ).resolves.toEqual({ verdict: 'observed', prompt: observed })
    expect(observe).toHaveBeenCalledWith('term_w', delivery(), 5)
  })

  it('reports unobserved — not dead — when a supported observation stalls', async () => {
    const { runtime } = runtimeObserving(delivery())
    await expect(
      observeWorkerTurnStart({
        runtime,
        terminalHandle: 'term_w',
        prompt: delivery(),
        timeoutMs: 5
      })
    ).resolves.toMatchObject({ verdict: 'unobserved' })
  })

  it('reports permission as positive liveness', async () => {
    const observed = delivery({ observation: 'permission' })
    const { runtime } = runtimeObserving(observed)
    await expect(
      observeWorkerTurnStart({
        runtime,
        terminalHandle: 'term_w',
        prompt: delivery(),
        timeoutMs: 5
      })
    ).resolves.toEqual({ verdict: 'permission', prompt: observed })
  })

  it('treats a replaced incarnation as unobserved rather than unsupported', async () => {
    const observed = delivery({ observation: 'incarnation_replaced' })
    const { runtime } = runtimeObserving(observed)
    await expect(
      observeWorkerTurnStart({
        runtime,
        terminalHandle: 'term_w',
        prompt: delivery(),
        timeoutMs: 5
      })
    ).resolves.toEqual({ verdict: 'unobserved', prompt: observed })
  })

  it('leaves an unsupported provider on the accepted receipt', async () => {
    const prompt = delivery({ provider: 'unsupported', observation: 'unsupported' })
    const { runtime, observe } = runtimeObserving(prompt)
    await expect(
      observeWorkerTurnStart({ runtime, terminalHandle: 'term_w', prompt })
    ).resolves.toEqual({ verdict: 'unsupported', prompt })
    expect(observe).not.toHaveBeenCalled()
  })

  it('preserves uncertainty when observation loses the terminal binding', async () => {
    const prompt = delivery()
    const { runtime, observe } = runtimeObserving(prompt)
    observe.mockRejectedValue(new Error('terminal_handle_stale'))
    await expect(
      observeWorkerTurnStart({ runtime, terminalHandle: 'term_w', prompt })
    ).resolves.toEqual({ verdict: 'unobserved', prompt })
    expect(observe).toHaveBeenCalledTimes(1)
  })
})
