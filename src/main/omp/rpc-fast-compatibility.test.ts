import { afterEach, expect, it } from 'vitest'
import { state } from '../pi/rpc-session-adapter.test-fixture'
import { setOmpFastMode } from './rpc-options'
import { closeOmpRpcAdapterFixtures, setupOmpRpcAdapter } from './rpc-session-adapter.test-fixture'

afterEach(closeOmpRpcAdapterFixtures)

it('sends a Gemini message with Fast off without a native unsupported-model notice', async () => {
  const model = {
    provider: 'relay',
    id: 'gemini-2.5-pro',
    api: 'openai-completions',
    identity: { class: 'gemini' }
  }
  const h = await setupOmpRpcAdapter('attempt', (connection) => {
    connection.requestOverride = (command) => {
      if (command === 'get_state') {
        return Promise.resolve({ ...state, model, fastModeEnabled: false, fastModeActive: false })
      }
      if (command === 'get_available_models') {
        return Promise.resolve({ models: [model] })
      }
      if (command === 'set_fast_mode') {
        connection.receive({
          type: 'notice',
          level: 'info',
          source: 'priority',
          message: 'The current model has no service-tier control for /fast to toggle.'
        })
        return Promise.resolve({ enabled: false, active: false })
      }
      return undefined
    }
  })
  const input = { sessionId: 'omp-test', fence: 1 }
  const outcome = await h.adapter.dispatch({
    ...input,
    clientMessageId: 'gemini-fast-off',
    executionOptions: { fastMode: 'false' },
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Continue' }] }
  })
  expect(outcome).toMatchObject({ state: 'admitted', ranOptions: { fastMode: 'false' } })
  expect(h.connection.sent).toContainEqual(
    expect.objectContaining({ type: 'prompt', message: 'Continue' })
  )
  expect((await h.rig.rows()).filter((row) => row.body.kind === 'status')).toEqual([])
})

it('clears a retained Fast preference even when the current model cannot activate it', async () => {
  let enabled = true
  await setOmpFastMode(
    {
      request: async (command, params) => {
        if (command === 'get_state') {
          return {
            model: { provider: 'relay', id: 'gemini-2.5-pro', api: 'openai-completions' },
            fastModeEnabled: enabled,
            fastModeActive: false
          }
        }
        if (command === 'set_fast_mode') {
          enabled = params?.enabled === true
          return { enabled, active: false }
        }
        throw new Error(`Unexpected request: ${command}`)
      }
    },
    false
  )
  expect(enabled).toBe(false)
})

it('does not enable Fast after a cancelled model-state query finishes', async () => {
  const query = Promise.withResolvers<unknown>()
  const controller = new AbortController()
  let enabled = false
  const setting = setOmpFastMode(
    {
      request: async (command, params) => {
        if (command === 'get_state') {
          return query.promise
        }
        if (command === 'set_fast_mode') {
          enabled = params?.enabled === true
          return { enabled, active: enabled }
        }
        throw new Error(`Unexpected request: ${command}`)
      }
    },
    true,
    controller.signal
  )
  controller.abort(new Error('Cancelled'))
  query.resolve({
    model: { provider: 'openai', id: 'gpt-6.1-sol' },
    fastModeEnabled: false,
    fastModeActive: false
  })
  await expect(setting).rejects.toThrow('Cancelled')
  expect(enabled).toBe(false)
})
