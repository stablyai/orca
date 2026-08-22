import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreloadApi } from './api-types'
import type {
  TerminalWindowTransferAck,
  TerminalWindowTransferCommand,
  TerminalWindowTransferSeed
} from '../shared/terminal-window-transfer'

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

describe('native terminal window preload IPC', () => {
  const originalContextIsolated = Object.getOwnPropertyDescriptor(process, 'contextIsolated')

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
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

  it('maps all four methods to their exact channels and removes the exact listener', async () => {
    const result = { ok: true, targetWindowId: 9 } as const
    const context = { windowId: 4, role: 'secondary' as const, transitionFenced: false }
    invoke.mockResolvedValueOnce(result).mockResolvedValueOnce(context)
    await import('./index')
    const api = exposeInMainWorld.mock.calls.find(([name]) => name === 'api')?.[1] as PreloadApi
    const seed = { tabId: 'tab-1' } as TerminalWindowTransferSeed
    const ack: TerminalWindowTransferAck = {
      transferId: 'transfer-1',
      tabId: 'tab-1',
      phase: 'target-import',
      ok: true
    }
    const command: TerminalWindowTransferCommand = {
      transferId: 'transfer-1',
      tabId: 'tab-1',
      seed,
      phase: 'target-import'
    }
    const callback = vi.fn()

    await expect(api.terminalWindow.detach(seed)).resolves.toEqual(result)
    api.terminalWindow.ack(ack)
    const unsubscribe = api.terminalWindow.onCommand(callback)
    const listener = on.mock.calls.find(([channel]) => channel === 'terminalWindow:command')?.[1]
    listener({}, command)
    unsubscribe()
    await expect(api.terminalWindow.getContext()).resolves.toEqual(context)

    expect(invoke).toHaveBeenNthCalledWith(1, 'terminalWindow:detach', seed)
    expect(send).toHaveBeenCalledExactlyOnceWith('terminalWindow:ack', ack)
    expect(callback).toHaveBeenCalledExactlyOnceWith(command)
    expect(removeListener).toHaveBeenCalledExactlyOnceWith('terminalWindow:command', listener)
    expect(invoke).toHaveBeenNthCalledWith(2, 'terminalWindow:getContext')
  })
})
