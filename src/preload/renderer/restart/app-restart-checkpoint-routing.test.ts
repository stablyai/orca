import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreloadApi } from '../../api-types'
import { ORCA_APP_RESTART_STARTED_EVENT } from '../../../shared/updater-renderer-events'

const { exposeInMainWorld, invoke, on, removeListener, send, sendSync, getPathForFile } =
  vi.hoisted(() => ({
    exposeInMainWorld: vi.fn(),
    invoke: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    send: vi.fn(),
    sendSync: vi.fn(),
    getPathForFile: vi.fn(() => '/files/notes.txt')
  }))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { invoke, on, removeListener, send, sendSync },
  webFrame: {
    getZoomFactor: vi.fn(() => 1),
    setZoomFactor: vi.fn(),
    setVisualZoomLevelLimits: vi.fn()
  },
  webUtils: { getPathForFile }
}))

describe('native preload destructive app actions', () => {
  const originalContextIsolated = Object.getOwnPropertyDescriptor(process, 'contextIsolated')
  let eventTarget: EventTarget

  beforeEach(() => {
    vi.resetModules()
    exposeInMainWorld.mockReset()
    invoke.mockReset()
    on.mockReset()
    removeListener.mockReset()
    send.mockReset()
    sendSync.mockReset()
    Object.defineProperty(process, 'contextIsolated', { configurable: true, value: true })
    eventTarget = new EventTarget()
    vi.stubGlobal('window', eventTarget)
    vi.stubGlobal('document', { addEventListener: vi.fn() })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    if (originalContextIsolated) {
      Object.defineProperty(process, 'contextIsolated', originalContextIsolated)
    } else {
      Reflect.deleteProperty(process, 'contextIsolated')
    }
  })

  const loadApi = async (): Promise<PreloadApi> => {
    await import('../../index')
    return exposeInMainWorld.mock.calls.find(([name]) => name === 'api')?.[1] as PreloadApi
  }

  it('exposes the durable checkpoint join the lazy-chunk recovery reload depends on', async () => {
    const api = await loadApi()
    invoke.mockResolvedValue({ ok: true })

    await expect(api.app.awaitBeforeUnloadCheckpoint()).resolves.toBeUndefined()
    expect(invoke).toHaveBeenCalledWith('app:await-before-unload-checkpoint')

    invoke.mockResolvedValue({ ok: false })

    await expect(api.app.awaitBeforeUnloadCheckpoint()).rejects.toThrow(
      'Failed to persist renderer state before unload.'
    )
  })

  it('awaits renderer durability before profile maintenance and preserves its result', async () => {
    const api = await loadApi()
    const started = vi.fn()
    eventTarget.addEventListener(ORCA_APP_RESTART_STARTED_EVENT, started)
    let finishCheckpoint = (_result: { ok: boolean }): void => {}
    const checkpoint = new Promise((resolve) => {
      finishCheckpoint = resolve
    })
    const result = { status: 'relaunching' }
    invoke.mockImplementation((channel: string) =>
      channel === 'app:await-before-unload-checkpoint' ? checkpoint : Promise.resolve(result)
    )

    const switching = api.orcaProfiles.switchProfile({ profileId: 'target' })
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('app:await-before-unload-checkpoint')
    )
    expect(started).toHaveBeenCalledOnce()
    expect(invoke).not.toHaveBeenCalledWith('orcaProfiles:switch', expect.anything())
    finishCheckpoint({ ok: true })
    await expect(switching).resolves.toBe(result)
    expect(invoke).toHaveBeenLastCalledWith('orcaProfiles:switch', { profileId: 'target' })
  })
})
