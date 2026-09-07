import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreloadApi } from './api-types'

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

describe('native preload linux package recovery methods', () => {
  const originalContextIsolated = Object.getOwnPropertyDescriptor(process, 'contextIsolated')

  beforeEach(() => {
    vi.resetModules()
    exposeInMainWorld.mockReset()
    invoke.mockReset()
    on.mockReset()
    removeListener.mockReset()
    send.mockReset()
    sendSync.mockReset()
    Object.defineProperty(process, 'contextIsolated', { configurable: true, value: true })
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      removeEventListener: vi.fn()
    })
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

  it('invokes only the instructions channel and returns the main-built command', async () => {
    const api = await loadApi()
    invoke.mockResolvedValueOnce({
      command: "sudo apt install -- '/cache/orca.deb'",
      packageFileName: 'orca.deb'
    })
    invoke.mockClear()

    await expect(api.updater.getLinuxPackageInstallInstructions()).resolves.toEqual({
      command: "sudo apt install -- '/cache/orca.deb'",
      packageFileName: 'orca.deb'
    })

    // Why: the renderer must never reach a generic shell/path channel for this cache artifact.
    expect(invoke.mock.calls).toEqual([['updater:getLinuxPackageInstallInstructions']])
  })

  it('invokes only the show-package channel', async () => {
    const api = await loadApi()
    invoke.mockResolvedValueOnce(undefined)
    invoke.mockClear()

    await expect(api.updater.showLinuxPackage()).resolves.toBeUndefined()

    expect(invoke.mock.calls).toEqual([['updater:showLinuxPackage']])
  })

  it('surfaces a main-process validation rejection to the caller', async () => {
    const api = await loadApi()
    invoke.mockRejectedValueOnce(new Error('hash mismatch'))

    await expect(api.updater.getLinuxPackageInstallInstructions()).rejects.toThrow('hash mismatch')
  })
})
