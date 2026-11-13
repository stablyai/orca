import { expect, it, vi, onTestFinished } from 'vitest'
import { createPiModelCatalogProbe } from './rpc-model-catalog-probe'
import type { AgentModelCatalogSuccess } from '../../../native-chat/agent-model-catalog/agent-model-catalog-entry'

it('publishes a slow inventory independently of state, then keeps the late default', async () => {
  vi.useFakeTimers()
  onTestFinished(() => vi.useRealTimers())
  const inventory = Promise.withResolvers<unknown>()
  const state = Promise.withResolvers<unknown>()
  const requested = Promise.withResolvers<void>()
  const observations: AgentModelCatalogSuccess[] = []
  const probe = createPiModelCatalogProbe({
    resolveEnvironment: async () => ({}),
    resolveCommand: () => process.execPath,
    probeVersion: async () => ({ version: '0.84.0' }),
    homePath: '/account',
    connect: () => ({
      request: (command, _params, options) => {
        // The real peer's explicit-null contract retains responses past its default 30s wait.
        if (options?.timeoutMs !== null) {
          return Promise.reject(new Error('catalog request retained its response deadline'))
        }
        if (command === 'get_available_models') {
          requested.resolve()
          return inventory.promise
        }
        return state.promise
      },
      close: async () => {}
    })
  })
  const result = probe(
    { variable: 'PI_CODING_AGENT_DIR', path: '/account' },
    { publish: (success) => observations.push(success) }
  )
  await requested.promise
  await vi.advanceTimersByTimeAsync(45_000)
  inventory.resolve({
    models: [{ id: 'gpt-live', provider: 'openai', name: 'GPT Live', reasoning: false }]
  })
  await vi.advanceTimersByTimeAsync(0)
  expect(observations[0]).toMatchObject({ models: [{ id: 'openai/gpt-live' }] })
  expect(observations[0].configured).toBeUndefined()
  state.resolve({ model: { id: 'gpt-live', provider: 'openai' }, thinkingLevel: 'high' })
  expect(await result).toMatchObject({
    models: [{ id: 'openai/gpt-live' }],
    configured: { model: 'openai/gpt-live', effort: 'high' }
  })
  expect(observations[0].configured).toBeUndefined()
})

it.each(['empty', 'rejected'])(
  'retains delayed sign-out evidence after %s inventory',
  async (kind) => {
    const state = Promise.withResolvers<unknown>()
    const requested = Promise.withResolvers<void>()
    const probe = createPiModelCatalogProbe({
      resolveEnvironment: async () => ({}),
      resolveCommand: () => process.execPath,
      probeVersion: async () => ({ version: '0.84.0' }),
      homePath: '/account',
      connect: () => ({
        request: (command) => {
          if (command === 'get_state') {
            return state.promise
          }
          requested.resolve()
          return kind === 'empty'
            ? Promise.resolve({ models: [] })
            : Promise.reject(new Error('inventory unavailable'))
        },
        close: async () => {}
      })
    })
    let settled = false
    const result = probe({ variable: 'PI_CODING_AGENT_DIR', path: '/account' }).finally(() => {
      settled = true
    })
    const verdict = expect(result).rejects.toMatchObject({ unavailable: { reason: 'notSignedIn' } })
    await requested.promise
    await Promise.resolve()
    expect(settled).toBe(false)
    state.resolve({ model: { id: 'unknown', provider: 'unknown' } })
    await verdict
  }
)
