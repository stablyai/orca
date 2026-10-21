import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { on } = vi.hoisted(() => ({ on: vi.fn() }))
vi.mock('electron', () => ({ ipcRenderer: { on } }))

describe('window glass preload bridge', () => {
  const argv = process.argv

  beforeEach(() => {
    vi.resetModules()
    on.mockClear()
    process.argv = [...argv]
  })

  afterEach(() => {
    process.argv = argv
  })

  it('defaults to unavailable for windows without a native material', async () => {
    const { windowGlassApi } = await import('./api/window-glass-bridge')
    expect(windowGlassApi.getWindowGlassAvailable()).toBe(false)
  })

  it('seeds availability from the main-process window argument', async () => {
    process.argv.push('--orca-window-glass=available')
    const { windowGlassApi } = await import('./api/window-glass-bridge')
    expect(windowGlassApi.getWindowGlassAvailable()).toBe(true)
  })

  it('caches early native changes and unsubscribes without exposing the IPC event', async () => {
    const { windowGlassApi } = await import('./api/window-glass-bridge')
    const listener = on.mock.calls.find(([channel]) => channel === 'window-glass:changed')?.[1]
    expect(listener).toBeTypeOf('function')
    listener({}, true)
    const callback = vi.fn()
    const unsubscribe = windowGlassApi.onWindowGlassChanged(callback)
    expect(callback).toHaveBeenLastCalledWith(true)
    listener({}, false)
    expect(callback).toHaveBeenLastCalledWith(false)
    expect(windowGlassApi.getWindowGlassAvailable()).toBe(false)
    unsubscribe()
    callback.mockClear()
    listener({}, true)
    expect(callback).not.toHaveBeenCalled()
  })

  it('fails closed on malformed availability messages', async () => {
    process.argv.push('--orca-window-glass=available')
    const { windowGlassApi } = await import('./api/window-glass-bridge')
    const listener = on.mock.calls[0]?.[1]
    listener({}, 'true')
    expect(windowGlassApi.getWindowGlassAvailable()).toBe(false)
  })
})
