import { expect, it, vi } from 'vitest'
import type { AgentSessionOptionsResult } from '../../shared/agent-session-wire'
import { OmpRpcFastOptions, readOmpFastOptions } from './rpc-options'

it.each([
  [{ provider: 'relay', api: 'openai-responses', identity: { class: 'openai' } }, true],
  [{ provider: 'openai-codex', api: 'openai-codex-responses', serviceTiers: ['flex'] }, false],
  [{ provider: 'github-copilot', api: 'openai-responses', identity: { class: 'openai' } }, false]
])(
  'offers the existing Fast picker only for an OMP-supported model %j',
  async (model, supported) => {
    const id = `${model.provider}/test`
    const result = await readOmpFastOptions(
      {
        request: async () => ({
          model: { ...model, id: 'test' },
          fastModeEnabled: false,
          fastModeActive: false
        })
      },
      {
        models: [{ id, label: 'Test', isDefault: false, efforts: [] }],
        current: { model: id }
      }
    )
    expect(result.models[0]?.supportsFastMode).toBe(supported)
    expect(result.fastModeSupport?.supported).toBe(supported)
    expect(result.current).toMatchObject({
      fastMode: false,
      fastModeState: 'off',
      confirmed: ['fastMode']
    })
  }
)

it.each([
  { model: { id: 'test' } },
  { model: { provider: 'openai', id: 'test', serviceTiers: [1] } },
  { fastModeEnabled: 'true' }
])('keeps the base options when optional Fast metadata is malformed: %j', async (state) => {
  const options: AgentSessionOptionsResult = {
    models: [{ id: 'openai/test', label: 'Test', isDefault: false, efforts: [] }],
    current: { model: 'openai/test', effort: 'high' }
  }
  await expect(readOmpFastOptions({ request: async () => state }, options)).resolves.toBe(options)
})

it('still reports a failed transport while reading Fast metadata', async () => {
  const failure = new Error('RPC disconnected')
  await expect(
    readOmpFastOptions(
      {
        request: async () => {
          throw failure
        }
      },
      { models: [], current: {} }
    )
  ).rejects.toBe(failure)
})

const options: AgentSessionOptionsResult = {
  models: [{ id: 'openai/test', label: 'Test', isDefault: false, efforts: [] }],
  current: { model: 'openai/test' }
}
const nativeState = {
  model: { provider: 'openai', id: 'test' },
  fastModeEnabled: false,
  fastModeActive: false
}

it('retains observed Fast metadata across a failed refresh without requesting on reads', async () => {
  const observed = new OmpRpcFastOptions()
  const rpc = {
    request: vi.fn().mockResolvedValueOnce(nativeState).mockRejectedValueOnce(new Error('Offline'))
  }
  await observed.request(rpc, 'get_state')
  await expect(observed.request(rpc, 'get_state')).rejects.toThrow('Offline')
  rpc.request.mockClear()
  expect(observed.read(options).current).toMatchObject({ fastMode: false, fastModeState: 'off' })
  expect(rpc.request).not.toHaveBeenCalled()
})

it('does not let a state read overwrite a newer successful Fast write', async () => {
  const observed = new OmpRpcFastOptions()
  await observed.request({ request: async () => nativeState }, 'get_state')
  const delayed = Promise.withResolvers<unknown>()
  const reading = observed.request({ request: () => delayed.promise }, 'get_state')
  await observed.request(
    { request: async () => ({ enabled: true, active: false }) },
    'set_fast_mode'
  )
  delayed.resolve(nativeState)
  await reading
  expect(observed.read(options).current).toMatchObject({ fastMode: true, fastModeState: 'off' })
})

it('ignores a state read issued during a pending Fast write', async () => {
  const observed = new OmpRpcFastOptions()
  await observed.request({ request: async () => nativeState }, 'get_state')
  const delayed = Promise.withResolvers<unknown>()
  const write = observed.request({ request: () => delayed.promise }, 'set_fast_mode')
  await observed.request(
    { request: async () => ({ ...nativeState, fastModeEnabled: true }) },
    'get_state'
  )
  expect(observed.read(options)).toBe(options)
  delayed.resolve({ enabled: true, active: true })
  await write
  expect(observed.read(options).current).toMatchObject({ fastMode: true, fastModeState: 'on' })
})

it('keeps the latest requested state when responses arrive out of order', async () => {
  const observed = new OmpRpcFastOptions()
  const delayed = Promise.withResolvers<unknown>()
  const first = observed.request({ request: () => delayed.promise }, 'get_state')
  await observed.request(
    { request: async () => ({ ...nativeState, fastModeEnabled: true }) },
    'get_state'
  )
  delayed.resolve(nativeState)
  await first
  expect(observed.read(options).current.fastMode).toBe(true)
})

it('retains Fast after a rejected control but requires a new observation after switching models', async () => {
  const observed = new OmpRpcFastOptions()
  await observed.request({ request: async () => nativeState }, 'get_state')
  await expect(
    observed.request(
      {
        request: async () => {
          throw new Error('Rejected')
        }
      },
      'set_fast_mode'
    )
  ).rejects.toThrow('Rejected')
  expect(observed.read(options).current.fastMode).toBe(false)
  expect(
    observed.read({ ...options, current: { model: 'openai/other' } }).current.fastMode
  ).toBeUndefined()
  await observed.request({ request: async () => ({}) }, 'set_model')
  expect(observed.read(options)).toBe(options)
  await observed.request({ request: async () => nativeState }, 'get_state')
  expect(observed.read(options).current.fastMode).toBe(false)
  expect(new OmpRpcFastOptions().read(options)).toBe(options)
})
