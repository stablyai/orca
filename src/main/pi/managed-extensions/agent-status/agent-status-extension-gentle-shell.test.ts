import { describe, expect, it } from 'vitest'
import { createAgentStatusExtensionHarness } from './agent-status-extension-test-harness'

describe('gentle-shell status extension', () => {
  it('posts lifecycle events to the gentle-shell route', async () => {
    const harness = createAgentStatusExtensionHarness({
      kind: 'gentle-shell',
      existsSync: () => true
    })

    await harness.callHook('agent_start', {}, { isIdle: () => false })

    expect(harness.fetchMock).toHaveBeenCalledTimes(1)
    expect(harness.fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:4321/hook/gentle-shell')
  })
})
