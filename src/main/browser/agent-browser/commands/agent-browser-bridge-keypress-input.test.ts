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
    webContents: { fromId: webContentsFromIdMock }
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
  createSucceedWith,
  mockBrowserManager,
  mockWebContents,
  overrideBridgeWebContentsLookup,
  resetAgentBrowserBridgeMocks,
  type MockWebContents
} from '../testing/agent-browser-bridge-test-harness'

overrideBridgeWebContentsLookup(AgentBrowserBridge.prototype, webContentsFromIdMock)

const succeedWith = createSucceedWith(execFileMock, stdinWrites)

describe('AgentBrowserBridge keypress input', () => {
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
    wc.debugger.sendCommand.mockResolvedValue({})
    webContentsFromIdMock.mockImplementation((id: number) => (id === 100 ? wc : null))
  })

  describe.each(['a', 'MediaPlayPause'])('target admission for %s', (key) => {
    function registerTwoWorkspaces(): MockWebContents {
      const otherPage = mockWebContents(200)
      otherPage.debugger.sendCommand.mockResolvedValue({})
      bridge = new AgentBrowserBridge(
        mockBrowserManager(
          new Map([
            ['tab-1', 100],
            ['tab-2', 200]
          ]),
          new Map([
            ['tab-1', 'workspace-1'],
            ['tab-2', 'workspace-2']
          ])
        )
      )
      bridge.setActiveTab(200)
      webContentsFromIdMock.mockImplementation((id: number) =>
        id === 100 ? wc : id === 200 ? otherPage : null
      )
      return otherPage
    }

    it('rejects a page belonging to another workspace before input or helper startup', async () => {
      const otherPage = registerTwoWorkspaces()
      succeedWith({ pressed: key })

      await expect(bridge.keypress(key, 'workspace-2', 'tab-1')).rejects.toMatchObject({
        code: 'browser_tab_not_found'
      })
      expect(wc.debugger.sendCommand).not.toHaveBeenCalled()
      expect(otherPage.debugger.sendCommand).not.toHaveBeenCalled()
      expect(execFileMock).not.toHaveBeenCalled()
      expect(CdpWsProxyMock.instances).toHaveLength(0)
    })
  })
})
