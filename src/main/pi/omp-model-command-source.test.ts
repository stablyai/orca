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
  it('switches through OMP API and reports the actual selected model', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    await harness.commands['orca-model'].handler('openai/test-model', commandContext())
    expect(harness.setModelMock).toHaveBeenCalledWith(model)
    expect(JSON.parse(String(harness.fetchMock.mock.calls[0][1]?.body)).payload).toEqual({
      hook_event_name: 'model_select',
      model: 'openai/test-model',
      model_switch_command: 'orca-model'
    })
  })

  it('does not claim a switch for an unavailable model or rejected API call', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    const context = commandContext()
    await harness.commands['orca-model'].handler('missing/model', context)
    expect(harness.setModelMock).not.toHaveBeenCalled()
    expect(context.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('no longer available'),
      'error'
    )
    harness.setModelMock.mockResolvedValue(false)
    await harness.commands['orca-model'].handler('openai/test-model', context)
    expect(context.ui.notify).toHaveBeenCalledWith(expect.stringContaining('no API key'), 'error')
    expect(harness.fetchMock).not.toHaveBeenCalled()
  })

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

  it('does not register for Pi or an inherited child owner', () => {
    expect(createAgentStatusExtensionHarness({ kind: 'pi' }).commands).toEqual({})
    expect(
      createAgentStatusExtensionHarness({ kind: 'omp', env: { ORCA_PI_STATUS_OWNED: '123' } })
        .commands
    ).toEqual({})
  })
})
