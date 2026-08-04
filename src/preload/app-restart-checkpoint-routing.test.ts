import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreloadApi } from './api-types'
import {
  ORCA_APP_RESTART_ABORTED_EVENT,
  ORCA_APP_RESTART_STARTED_EVENT
} from '../shared/updater-renderer-events'

const { exposeInMainWorld, invoke, on, removeListener, send, sendSync } = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  send: vi.fn(),
  sendSync: vi.fn()
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { invoke, on, removeListener, send, sendSync },
  webFrame: {
    getZoomFactor: vi.fn(() => 1),
    setZoomFactor: vi.fn(),
    setVisualZoomLevelLimits: vi.fn()
  },
  webUtils: { getPathForFile: vi.fn(() => '') }
}))

vi.mock('@electron-toolkit/preload', () => ({ electronAPI: {} }))

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
    await import('./index')
    return exposeInMainWorld.mock.calls.find(([name]) => name === 'api')?.[1] as PreloadApi
  }

  for (const action of ['reload', 'relaunch'] as const) {
    it(`prepares and awaits durability before ${action}`, async () => {
      const api = await loadApi()
      const calls: string[] = []
      eventTarget.addEventListener(ORCA_APP_RESTART_STARTED_EVENT, () => calls.push('prepared'))
      invoke.mockImplementation(async (channel: string) => {
        calls.push(channel)
        return channel === 'app:await-before-unload-checkpoint' ? { ok: true } : undefined
      })

      await api.app[action]()

      expect(calls).toEqual(['prepared', 'app:await-before-unload-checkpoint', `app:${action}`])
    })

    it(`refuses ${action} when the durable checkpoint fails`, async () => {
      const api = await loadApi()
      const aborted = vi.fn()
      eventTarget.addEventListener(ORCA_APP_RESTART_ABORTED_EVENT, aborted)
      invoke.mockImplementation(async (channel: string) =>
        channel === 'app:await-before-unload-checkpoint' ? { ok: false } : undefined
      )

      await expect(api.app[action]()).rejects.toThrow(
        'Failed to persist renderer state before unload.'
      )

      expect(invoke).not.toHaveBeenCalledWith(`app:${action}`)
      expect(aborted).toHaveBeenCalledTimes(1)
    })
  }
})
