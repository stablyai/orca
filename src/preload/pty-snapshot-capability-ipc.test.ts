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

describe('PTY snapshot capability preload IPC', () => {
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

  it('queries capabilities asynchronously without parking the renderer', async () => {
    const capabilities = [{ id: 'ssh-pty', authoritative: false }]
    invoke.mockResolvedValueOnce(capabilities)
    await import('./index')
    const api = exposeInMainWorld.mock.calls.find(([name]) => name === 'api')?.[1] as PreloadApi

    await expect(
      api.pty.getAuthoritativeBufferSnapshotCapabilities?.(['ssh-pty'])
    ).resolves.toEqual(capabilities)
    expect(invoke).toHaveBeenCalledWith('pty:getAuthoritativeBufferSnapshotCapabilities', {
      ids: ['ssh-pty']
    })
    expect(sendSync).not.toHaveBeenCalledWith(
      'pty:getAuthoritativeBufferSnapshotCapabilitiesSync',
      expect.anything()
    )
  })
})
