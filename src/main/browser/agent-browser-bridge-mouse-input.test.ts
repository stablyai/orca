import { describe, it, expect, vi, beforeEach } from 'vitest'

const {
  execFileMock,
  webContentsFromIdMock,
  existsSyncMock,
  readFileSyncMock,
  stdinWrites,
  waitForTabRegistrationMock
} = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  webContentsFromIdMock: vi.fn(),
  existsSyncMock: vi.fn(() => false),
  readFileSyncMock: vi.fn(() => Buffer.from('')),
  stdinWrites: [] as string[],
  waitForTabRegistrationMock: vi.fn()
}))

vi.mock('child_process', () => ({ execFile: execFileMock }))
vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
  accessSync: vi.fn(),
  chmodSync: vi.fn(),
  constants: { X_OK: 1 }
}))
vi.mock('os', () => ({ platform: () => 'darwin', arch: () => 'arm64' }))
vi.mock('electron', () => {
  return {
    app: { getPath: vi.fn(() => '/app'), getAppPath: vi.fn(() => '/project'), isPackaged: false },
    webContents: { fromId: webContentsFromIdMock }
  }
})
vi.mock('../ipc/browser-tab-registration-wait', () => ({
  waitForTabRegistration: waitForTabRegistrationMock
}))
const { CdpWsProxyMock } = vi.hoisted(() => {
  const instances: unknown[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const MockClass = vi.fn().mockImplementation(function (this: any, _wc: unknown) {
    this._wc = _wc
    this.start = vi.fn(async () => 'ws://127.0.0.1:9222')
    this.stop = vi.fn(async () => {})
    this.getPort = vi.fn(() => 9222)
    instances.push(this)
  })
  return { CdpWsProxyMock: Object.assign(MockClass, { instances }) }
})

vi.mock('./cdp-ws-proxy', () => ({
  CdpWsProxy: CdpWsProxyMock
}))
vi.mock('./cdp-bridge', () => ({
  BrowserError: class BrowserError extends Error {
    code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  }
}))

import { AgentBrowserBridge } from './agent-browser-bridge'
import {
  mockBrowserManager,
  mockWebContents,
  overrideBridgeWebContentsLookup,
  resetAgentBrowserBridgeMocks,
  type ExecFileCallback
} from './agent-browser-bridge-test-harness'

overrideBridgeWebContentsLookup(AgentBrowserBridge.prototype, webContentsFromIdMock)

describe('AgentBrowserBridge', () => {
  let bridge: AgentBrowserBridge

  beforeEach(() => {
    resetAgentBrowserBridgeMocks({
      webContentsFromIdMock,
      existsSyncMock,
      readFileSyncMock,
      stdinWrites,
      cdpWsProxyInstances: CdpWsProxyMock.instances
    })
    waitForTabRegistrationMock.mockReset()
    waitForTabRegistrationMock.mockResolvedValue(undefined)
    bridge = new AgentBrowserBridge(mockBrowserManager())
    bridge.setActiveTab(100)
  })

  it('uses the runtime mobile tap path when a nearby DOM target is handled', async () => {
    const wc = mockWebContents(100)
    wc.debugger.sendCommand.mockImplementation(async (method: string) => {
      if (method === 'Runtime.evaluate') {
        return { result: { value: { x: 12, y: 34, adjusted: true, handled: true } } }
      }
      return {}
    })
    webContentsFromIdMock.mockReturnValue(wc)

    const result = await bridge.mouseClick(10, 20, 'left', undefined, 'tab-1', 18)

    expect(result).toEqual({
      clicked: { x: 12, y: 34, button: 'left', adjusted: true, handled: true }
    })
    expect(wc.debugger.sendCommand).toHaveBeenCalledWith(
      'Runtime.evaluate',
      expect.objectContaining({ returnByValue: true, silent: true })
    )
    expect(
      wc.debugger.sendCommand.mock.calls.some((call) => call[0] === 'Input.dispatchMouseEvent')
    ).toBe(false)
  })

  it('falls back to CDP mouse events when runtime does not handle a mobile tap', async () => {
    const wc = mockWebContents(100)
    wc.debugger.sendCommand.mockImplementation(async (method: string) => {
      if (method === 'Runtime.evaluate') {
        return { result: { value: { x: 10, y: 20, adjusted: false, handled: false } } }
      }
      return {}
    })
    webContentsFromIdMock.mockReturnValue(wc)

    await expect(bridge.mouseClick(10, 20, 'left', undefined, 'tab-1', 18)).resolves.toEqual({
      clicked: { x: 10, y: 20, button: 'left', adjusted: false, handled: false }
    })

    const mouseCalls = wc.debugger.sendCommand.mock.calls.filter(
      (call) => call[0] === 'Input.dispatchMouseEvent'
    )
    expect(mouseCalls).toHaveLength(3)
    expect(mouseCalls[0]?.[1]).toMatchObject({ type: 'mouseMoved', x: 10, y: 20 })
    expect(mouseCalls[1]?.[1]).toMatchObject({ type: 'mousePressed', x: 10, y: 20 })
    expect(mouseCalls[2]?.[1]).toMatchObject({ type: 'mouseReleased', x: 10, y: 20 })
  })

  it('passes mobile click modifiers through to CDP mouse events', async () => {
    const wc = mockWebContents(100)
    wc.debugger.sendCommand.mockImplementation(async (method: string) => {
      if (method === 'Runtime.evaluate') {
        return { result: { value: { x: 10, y: 20, adjusted: false, handled: false } } }
      }
      return {}
    })
    webContentsFromIdMock.mockReturnValue(wc)

    await bridge.mouseClick(10, 20, 'left', undefined, 'tab-1', 18, ['cmd', 'shift'])

    const mouseCalls = wc.debugger.sendCommand.mock.calls.filter(
      (call) => call[0] === 'Input.dispatchMouseEvent'
    )
    expect(mouseCalls[1]?.[1]).toMatchObject({ type: 'mousePressed', modifiers: 12 })
    expect(mouseCalls[2]?.[1]).toMatchObject({ type: 'mouseReleased', modifiers: 12 })
  })

  it('keeps adjusted mobile tap coordinates but uses CDP for modifier clicks', async () => {
    const wc = mockWebContents(100)
    wc.debugger.sendCommand.mockImplementation(async (method: string) => {
      if (method === 'Runtime.evaluate') {
        return { result: { value: { x: 12, y: 34, adjusted: true, handled: false } } }
      }
      return {}
    })
    webContentsFromIdMock.mockReturnValue(wc)

    await expect(
      bridge.mouseClick(10, 20, 'left', undefined, 'tab-1', 18, ['cmd'])
    ).resolves.toEqual({
      clicked: { x: 12, y: 34, button: 'left', adjusted: true, handled: false }
    })

    const evaluateCall = wc.debugger.sendCommand.mock.calls.find(
      (call) => call[0] === 'Runtime.evaluate'
    )
    expect((evaluateCall?.[1] as { expression?: string } | undefined)?.expression).toContain(
      'const allowDomActivation = false'
    )
    const mouseCalls = wc.debugger.sendCommand.mock.calls.filter(
      (call) => call[0] === 'Input.dispatchMouseEvent'
    )
    expect(mouseCalls).toHaveLength(3)
    expect(mouseCalls[1]?.[1]).toMatchObject({ type: 'mousePressed', x: 12, y: 34, modifiers: 4 })
    expect(mouseCalls[2]?.[1]).toMatchObject({ type: 'mouseReleased', x: 12, y: 34, modifiers: 4 })
  })

  it('drops empty command queues after direct CDP commands finish', async () => {
    const wc = mockWebContents(100)
    wc.debugger.sendCommand.mockResolvedValue({})
    webContentsFromIdMock.mockReturnValue(wc)

    await bridge.mouseClick(10, 20, 'right', undefined, 'tab-1')

    expect(
      (bridge as unknown as { commandQueues: Map<string, unknown[]> }).commandQueues.size
    ).toBe(0)
    expect((bridge as unknown as { processingQueues: Set<string> }).processingQueues.size).toBe(0)
  })

  it('navigates history directly without spawning the page helper', async () => {
    const wc = mockWebContents(100)
    let currentUrl = 'https://example.com/next'
    const listeners = new Map<string, (...args: never[]) => void>()
    wc.getURL = () => currentUrl
    wc.on.mockImplementation((event: string, listener: (...args: never[]) => void) => {
      listeners.set(event, listener)
      return wc.on
    })
    wc.removeListener.mockImplementation((event: string) => {
      listeners.delete(event)
      return wc.removeListener
    })
    Object.assign(wc, {
      navigationHistory: {
        canGoBack: vi.fn(() => true),
        canGoForward: vi.fn(() => false),
        goBack: vi.fn(() => {
          currentUrl = 'https://example.com/'
          queueMicrotask(() => listeners.get('did-navigate')?.())
        }),
        goForward: vi.fn()
      }
    })
    webContentsFromIdMock.mockReturnValue(wc)

    await expect(bridge.back(undefined, 'tab-1')).resolves.toEqual({
      url: 'https://example.com/',
      title: 'Example'
    })

    expect(execFileMock).not.toHaveBeenCalled()
    expect(listeners.size).toBe(0)
  })

  it('waits for replacement guest registration after history destroys the old guest', async () => {
    const tabs = new Map([['tab-1', 100]])
    const replacementBridge = new AgentBrowserBridge(mockBrowserManager(tabs))
    replacementBridge.setActiveTab(100)
    const oldWebContents = mockWebContents(100)
    const replacementWebContents = mockWebContents(200)
    replacementWebContents.getURL = () => 'https://example.com/replaced'
    replacementWebContents.getTitle = () => 'Replaced'
    const listeners = new Map<string, (...args: never[]) => void>()
    oldWebContents.on.mockImplementation((event: string, listener: (...args: never[]) => void) => {
      listeners.set(event, listener)
      return oldWebContents.on
    })
    oldWebContents.removeListener.mockImplementation((event: string) => {
      listeners.delete(event)
      return oldWebContents.removeListener
    })
    Object.assign(oldWebContents, {
      navigationHistory: {
        canGoBack: vi.fn(() => true),
        canGoForward: vi.fn(() => false),
        goBack: vi.fn(() => queueMicrotask(() => listeners.get('destroyed')?.())),
        goForward: vi.fn()
      }
    })
    webContentsFromIdMock.mockImplementation((id: number) =>
      id === 100 ? oldWebContents : id === 200 ? replacementWebContents : null
    )
    let releaseRegistration!: () => void
    waitForTabRegistrationMock.mockImplementation(
      () => new Promise<void>((resolve) => (releaseRegistration = resolve))
    )

    const pending = replacementBridge.back(undefined, 'tab-1')
    await vi.waitFor(() => expect(waitForTabRegistrationMock).toHaveBeenCalledWith('tab-1'))
    tabs.set('tab-1', 200)
    releaseRegistration()

    await expect(pending).resolves.toEqual({
      url: 'https://example.com/replaced',
      title: 'Replaced'
    })
  })

  it('models the legacy helper losing its reply after history navigation', async () => {
    vi.stubEnv('ORCA_E2E_DISABLE_BROWSER_DIRECT_HISTORY_NAVIGATION', '1')
    let helperStarted = false
    execFileMock.mockImplementation(
      (_bin: string, args: string[], _options: unknown, callback: ExecFileCallback) => {
        if (args.includes('back')) {
          helperStarted = true
        } else {
          callback(null, JSON.stringify({ success: true, data: {} }), '')
        }
        return { stdin: { on: vi.fn(), end: vi.fn() } }
      }
    )

    try {
      const pending = bridge.back(undefined, 'tab-1')
      let settled = false
      void pending.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        }
      )

      await vi.waitFor(() => expect(helperStarted).toBe(true))
      await Promise.resolve()

      expect(settled).toBe(false)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('keeps replacement-page input queued behind teardown of an in-flight command', async () => {
    const tabs = new Map([['tab-1', 100]])
    const b = new AgentBrowserBridge(mockBrowserManager(tabs))
    b.setActiveTab(100)
    const oldWc = mockWebContents(100)
    const newWc = mockWebContents(200)
    let releaseOldMove: (() => void) | null = null
    oldWc.debugger.sendCommand.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          releaseOldMove = () => resolve({})
        })
    )
    webContentsFromIdMock.mockImplementation((id: number) => (id === 100 ? oldWc : newWc))

    const oldMove = b.mouseMove(10, 20, undefined, 'tab-1')
    await vi.waitFor(() => expect(releaseOldMove).not.toBeNull())
    const close = b.onTabClosed(100)
    tabs.set('tab-1', 200)
    const replacementMove = b.mouseMove(30, 40, undefined, 'tab-1')
    await Promise.resolve()

    expect(newWc.debugger.sendCommand).not.toHaveBeenCalled()
    releaseOldMove!()
    await oldMove
    await close
    await replacementMove

    expect(newWc.debugger.sendCommand).toHaveBeenCalledWith('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: 30,
      y: 40,
      buttons: 0
    })
    expect((b as unknown as { processingQueues: Set<string> }).processingQueues.size).toBe(0)
  })
})
