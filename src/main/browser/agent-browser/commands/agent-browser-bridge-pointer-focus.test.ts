import { describe, it, expect, vi, beforeEach } from 'vitest'

const { execFileMock, webContentsFromIdMock, existsSyncMock, readFileSyncMock, stdinWrites } =
  vi.hoisted(() => {
    const stdinWrites: string[] = []
    return {
      execFileMock: vi.fn(),
      webContentsFromIdMock: vi.fn(),
      existsSyncMock: vi.fn(() => false),
      readFileSyncMock: vi.fn(() => Buffer.from('')),
      stdinWrites
    }
  })

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
    webContents: { fromId: webContentsFromIdMock },
    // The popup's own window is not the focused window.
    BrowserWindow: { fromWebContents: () => ({ isFocused: () => false }) }
  }
})
const { CdpWsProxyMock } = vi.hoisted(() => {
  const instances: unknown[] = []
  const MockClass = vi.fn().mockImplementation(function (
    this: Record<string, unknown>,
    _wc: unknown
  ) {
    this._wc = _wc
    this.start = vi.fn(async () => 'ws://127.0.0.1:9222')
    this.stop = vi.fn(async () => {})
    this.getPort = vi.fn(() => 9222)
    instances.push(this)
  })
  return { CdpWsProxyMock: Object.assign(MockClass, { instances }) }
})

vi.mock('../../cdp/transport/cdp-ws-proxy', () => ({
  CdpWsProxy: CdpWsProxyMock
}))

import { AgentBrowserBridge } from '../agent-browser-bridge'
import {
  mockBrowserManager,
  mockWebContents,
  overrideBridgeWebContentsLookup,
  resetAgentBrowserBridgeMocks,
  type MockWebContents
} from '../testing/agent-browser-bridge-test-harness'

overrideBridgeWebContentsLookup(AgentBrowserBridge.prototype, webContentsFromIdMock)

describe('AgentBrowserBridge presses on pages outside an Orca pane', () => {
  let bridge: AgentBrowserBridge
  let wc: MockWebContents

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
    wc = mockWebContents(100)
    wc.debugger.sendCommand.mockImplementation(async (method: string) =>
      method === 'Runtime.evaluate'
        ? { result: { value: { x: 10, y: 20, adjusted: false, handled: false } } }
        : {}
    )
    webContentsFromIdMock.mockImplementation((id: number) => (id === 100 ? wc : null))
  })

  function sentBeforePress(): string[] {
    const methods = wc.debugger.sendCommand.mock.calls.map(([method, params]) =>
      method === 'Input.dispatchMouseEvent' &&
      typeof params === 'object' &&
      params !== null &&
      'type' in params
        ? `${method}:${String(params.type)}`
        : method
    )
    return methods.slice(0, methods.indexOf('Input.dispatchMouseEvent:mousePressed'))
  }

  it.each([
    ['click', () => bridge.mouseClick(10, 20, 'left', undefined, 'tab-1')],
    ['mouse down', () => bridge.mouseDown('left', undefined, 'tab-1')]
  ])(
    '%s on a popup whose window is not focused emulates focus instead of taking it',
    async (_name, press) => {
      await press()

      expect(wc.focus).not.toHaveBeenCalled()
      expect(sentBeforePress()).toContain('Emulation.setFocusEmulationEnabled')
    }
  )
})
