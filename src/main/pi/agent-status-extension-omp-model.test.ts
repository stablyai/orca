import { describe, expect, it, vi } from 'vitest'

import { createAgentStatusExtensionHarness } from './agent-status-extension-test-harness'

/** The `payload` of every hook POST the extension made, in order. */
function postedPayloads(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown>[] {
  return fetchMock.mock.calls.map(
    (call) => JSON.parse(String(call[1]?.body)).payload as Record<string, unknown>
  )
}

/** Waits until `count` posts have been delivered.
 *  Why: delivery is latest-only behind one in-flight post, so back-to-back hooks
 *  must drain before the next one or the pending slot swallows the earlier post. */
async function settled(fetchMock: ReturnType<typeof vi.fn>, count: number): Promise<void> {
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(count))
}

const DEEPSEEK = { provider: 'deepseek', id: 'deepseek-v4-pro' }
const MINIMAX = { provider: 'minimax-cn', id: 'MiniMax-M3' }

const OMP_RUNTIME_CASES = [
  ['configured OMP', { kind: 'omp' as const }],
  ['title-routed OMP', { kind: 'pi' as const, title: 'omp' }],
  ['argv-routed OMP', { kind: 'pi' as const, argv: ['node', '/usr/local/bin/omp'] }]
] as const

describe('OMP model reporting', () => {
  it.each(OMP_RUNTIME_CASES)('stamps the active model on every %s post', async (_name, args) => {
    const harness = createAgentStatusExtensionHarness(args)

    await harness.callHook('agent_start', undefined, { model: DEEPSEEK })
    await settled(harness.fetchMock, 1)
    await harness.callHook(
      'tool_call',
      { toolName: 'bash', input: { command: 'ls' } },
      { model: DEEPSEEK }
    )
    await settled(harness.fetchMock, 2)

    expect(postedPayloads(harness.fetchMock)).toEqual([
      { hook_event_name: 'agent_start', model: 'deepseek/deepseek-v4-pro' },
      {
        hook_event_name: 'tool_call',
        model: 'deepseek/deepseek-v4-pro',
        tool_name: 'bash',
        tool_input: { command: 'ls' }
      }
    ])
  })

  it('follows a switch the context reports on a later event', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })

    await harness.callHook('agent_start', undefined, { model: DEEPSEEK })
    await settled(harness.fetchMock, 1)
    await harness.callHook('agent_end', {}, { model: MINIMAX, isIdle: () => true })
    await settled(harness.fetchMock, 2)

    expect(postedPayloads(harness.fetchMock).map((payload) => payload.model)).toEqual([
      'deepseek/deepseek-v4-pro',
      'minimax-cn/MiniMax-M3'
    ])
  })

  it('keeps the last known model when an event context carries none', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })

    await harness.callHook('agent_start', undefined, { model: DEEPSEEK })
    await settled(harness.fetchMock, 1)
    await harness.callHook('tool_execution_end', { toolName: 'bash' }, { model: null })
    await settled(harness.fetchMock, 2)
    await harness.callHook('tool_execution_end', { toolName: 'bash' }, {})
    await settled(harness.fetchMock, 3)

    expect(postedPayloads(harness.fetchMock).map((payload) => payload.model)).toEqual([
      'deepseek/deepseek-v4-pro',
      'deepseek/deepseek-v4-pro',
      'deepseek/deepseek-v4-pro'
    ])
  })

  it('posts model_select with the newly selected model', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })

    await harness.callHook(
      'model_select',
      { model: MINIMAX, previousModel: DEEPSEEK, source: 'set' },
      // Why: the event names the switch; the context may still read the old model.
      { model: DEEPSEEK }
    )

    expect(postedPayloads(harness.fetchMock)).toEqual([
      { hook_event_name: 'model_select', model: 'minimax-cn/MiniMax-M3' }
    ])
  })

  it('never reports a model from a plain Pi runtime', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })

    await harness.callHook('agent_start', undefined, { model: DEEPSEEK })
    await settled(harness.fetchMock, 1)
    await harness.callHook('model_select', { model: MINIMAX, source: 'set' }, { model: MINIMAX })
    await harness.callHook('tool_execution_end', { toolName: 'bash' }, { model: MINIMAX })
    await settled(harness.fetchMock, 2)

    expect(postedPayloads(harness.fetchMock)).toEqual([
      { hook_event_name: 'agent_start' },
      { hook_event_name: 'tool_execution_end', tool_name: 'bash' }
    ])
  })

  it('survives a throwing model getter', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    const context = {
      get model(): never {
        throw new Error('registry not ready')
      }
    }

    await harness.callHook('agent_start', undefined, context)

    expect(postedPayloads(harness.fetchMock)).toEqual([{ hook_event_name: 'agent_start' }])
  })
})
