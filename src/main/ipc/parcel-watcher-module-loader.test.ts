import { beforeEach, expect, it, vi } from 'vitest'
import { loadParcelWatcher } from './parcel-watcher-module-loader'

const state = vi.hoisted(() => ({ named: undefined as unknown, fallback: undefined as unknown }))
vi.mock('@parcel/watcher', () => ({
  get subscribe() {
    return state.named
  },
  get default() {
    return state.fallback
  }
}))
beforeEach(() => {
  state.named = undefined
  state.fallback = undefined
})

it('uses named exports when the runtime exposes them', async () => {
  const subscribe = vi.fn()
  state.named = subscribe
  state.fallback = { subscribe: vi.fn() }
  expect((await loadParcelWatcher()).subscribe).toBe(subscribe)
})

it('loads the full CommonJS default when a packaged wrapper has no named exports', async () => {
  const subscribe = vi.fn()
  const getEventsSince = vi.fn()
  state.fallback = { subscribe, getEventsSince }
  expect(await loadParcelWatcher()).toBe(state.fallback)
  expect((await loadParcelWatcher()).getEventsSince).toBe(getEventsSince)
})

it.each([undefined, null, {}, { subscribe: false }])(
  'rejects invalid watcher exports (%j)',
  async (fallback) => {
    state.fallback = fallback
    await expect(loadParcelWatcher()).rejects.toThrow('parcel_watcher_module_invalid')
  }
)
