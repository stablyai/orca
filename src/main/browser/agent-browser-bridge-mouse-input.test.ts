import { describe, it, expect, vi, beforeEach } from 'vitest'

const { execFileMock, webContentsFromIdMock, existsSyncMock, readFileSyncMock, stdinWrites } =
  vi.hoisted(() => ({
    execFileMock: vi.fn(),
    webContentsFromIdMock: vi.fn(),
    existsSyncMock: vi.fn(() => false),
    readFileSyncMock: vi.fn(() => Buffer.from('')),
    stdinWrites: [] as string[]
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
  resetAgentBrowserBridgeMocks
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
    expect(mouseCalls).toHaveLength(2)
    expect(mouseCalls[0]?.[1]).toMatchObject({ type: 'mousePressed', x: 10, y: 20 })
    expect(mouseCalls[1]?.[1]).toMatchObject({ type: 'mouseReleased', x: 10, y: 20 })
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
    expect(mouseCalls[0]?.[1]).toMatchObject({ type: 'mousePressed', modifiers: 12 })
    expect(mouseCalls[1]?.[1]).toMatchObject({ type: 'mouseReleased', modifiers: 12 })
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
    expect(mouseCalls).toHaveLength(2)
    expect(mouseCalls[0]?.[1]).toMatchObject({ type: 'mousePressed', x: 12, y: 34, modifiers: 4 })
    expect(mouseCalls[1]?.[1]).toMatchObject({ type: 'mouseReleased', x: 12, y: 34, modifiers: 4 })
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
})
