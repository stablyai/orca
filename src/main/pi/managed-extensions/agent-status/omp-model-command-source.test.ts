import { describe, expect, it, vi } from 'vitest'
import { createAgentStatusExtensionHarness } from './agent-status-extension-test-harness'

const discovered = { provider: 'opencode-zen', id: 'grok-4.7' }

describe('OMP /orca-model command', () => {
  it('selects a model that appears once background discovery settles', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    let available: { provider: string; id: string }[] = []
    const context = {
      modelRegistry: {
        getAvailable: () => available,
        awaitBackgroundRefresh: vi.fn(async () => {
          available = [discovered]
        })
      },
      ui: { notify: vi.fn() }
    }

    await harness.commands['orca-model'].handler('opencode-zen/grok-4.7', context)

    expect(harness.setModelMock).toHaveBeenCalledWith(discovered)
    expect(context.ui.notify).toHaveBeenCalledExactlyOnceWith(
      'Waiting for model discovery...',
      'info'
    )
  })

  it('keeps a newer pick when an earlier one was still waiting for discovery', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    const listed = { provider: 'anthropic', id: 'claude-opus' }
    const refresh = Promise.withResolvers<void>()
    let available = [listed]
    const context = {
      modelRegistry: {
        getAvailable: () => available,
        awaitBackgroundRefresh: () => refresh.promise
      },
      ui: { notify: vi.fn() }
    }

    const earlier = harness.commands['orca-model'].handler('opencode-zen/grok-4.7', context)
    await harness.commands['orca-model'].handler('anthropic/claude-opus', context)
    available = [listed, discovered]
    refresh.resolve()
    await earlier

    expect(harness.setModelMock).toHaveBeenCalledExactlyOnceWith(listed)
  })

  it('does not wait for discovery when the model is already listed', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    const context = {
      modelRegistry: {
        getAvailable: () => [discovered],
        awaitBackgroundRefresh: vi.fn(async () => undefined)
      },
      ui: { notify: vi.fn() }
    }

    await harness.commands['orca-model'].handler('opencode-zen/grok-4.7', context)

    expect(context.modelRegistry.awaitBackgroundRefresh).not.toHaveBeenCalled()
    expect(harness.setModelMock).toHaveBeenCalledWith(discovered)
  })

  it('reports a model still missing after discovery settles', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    const context = {
      modelRegistry: {
        getAvailable: () => [],
        awaitBackgroundRefresh: vi.fn(async () => undefined)
      },
      ui: { notify: vi.fn() }
    }

    await harness.commands['orca-model'].handler('opencode-zen/grok-4.7', context)

    expect(harness.setModelMock).not.toHaveBeenCalled()
    expect(context.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('no longer available'),
      'error'
    )
  })
})
