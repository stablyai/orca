import { describe, expect, it, vi } from 'vitest'
import { createAgentStatusExtensionHarness } from './agent-status-extension-test-harness'

const model = { provider: 'openai', id: 'test-model' }

function commandContext() {
  return {
    modelRegistry: { getAvailable: () => [model] },
    ui: { notify: vi.fn() }
  }
}

describe('OMP model command', () => {
  it('keeps a queued completion when a model switch arrives before delivery', async () => {
    let release: (response: Response) => void = () => {}
    const harness = createAgentStatusExtensionHarness({
      kind: 'omp',
      fetchImpl: () =>
        new Promise<Response>((resolve) => {
          release = resolve
        })
    })
    await harness.callHook('agent_start')
    await harness.callHook('agent_end', {}, { isIdle: () => true })
    await harness.commands['orca-model'].handler('openai/test-model', commandContext())
    release(new Response('', { status: 200 }))
    await vi.waitFor(() => expect(harness.fetchMock).toHaveBeenCalledTimes(2))
    expect(JSON.parse(String(harness.fetchMock.mock.calls[1][1]?.body)).payload).toMatchObject({
      hook_event_name: 'agent_end',
      model: 'openai/test-model'
    })
    release(new Response('', { status: 200 }))
  })
})
