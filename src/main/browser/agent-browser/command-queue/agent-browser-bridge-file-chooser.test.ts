import { EventEmitter } from 'node:events'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AgentBrowserBridge } from '../agent-browser-bridge'
import { runInRemoteCliBrowserScope } from '../../../runtime/desktop-browser-bridge/remote-cli-browser-scope'
import {
  answerAgentBrowserCommands,
  mockBrowserManager,
  mockWebContents,
  overrideBridgeWebContentsLookup,
  resetAgentBrowserBridgeMocks
} from '../testing/agent-browser-bridge-test-harness'

const { execFileMock, webContentsFromIdMock, existsSyncMock, readFileSyncMock, stdinWrites } =
  vi.hoisted(() => ({
    execFileMock: vi.fn(),
    webContentsFromIdMock: vi.fn(),
    existsSyncMock: vi.fn(() => false),
    readFileSyncMock: vi.fn(() => Buffer.from('')),
    stdinWrites: new Array<string>()
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
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/app'), getAppPath: vi.fn(() => '/project'), isPackaged: false },
  webContents: { fromId: webContentsFromIdMock }
}))
const { CdpWsProxyMock } = vi.hoisted(() => {
  const instances: unknown[] = []
  const MockClass = vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.start = vi.fn(async () => 'ws://127.0.0.1:9222')
    this.stop = vi.fn(async () => {})
    this.getPort = vi.fn(() => 9222)
    this.pointAtNextNode = vi.fn()
    instances.push(this)
  })
  return { CdpWsProxyMock: Object.assign(MockClass, { instances }) }
})
vi.mock('../../cdp/transport/cdp-ws-proxy', () => ({ CdpWsProxy: CdpWsProxyMock }))

overrideBridgeWebContentsLookup(AgentBrowserBridge.prototype, webContentsFromIdMock)

describe('an agent click that opens a file picker', () => {
  let debuggerEvents: EventEmitter
  let intercepting: boolean
  let bridge: AgentBrowserBridge
  let onClick: () => void

  beforeEach(() => {
    resetAgentBrowserBridgeMocks({
      webContentsFromIdMock,
      existsSyncMock,
      readFileSyncMock,
      stdinWrites,
      cdpWsProxyInstances: CdpWsProxyMock.instances
    })
    intercepting = false
    onClick = () => {}
    debuggerEvents = new EventEmitter()
    const guest = mockWebContents(100)
    guest.debugger = {
      isAttached: vi.fn(() => true),
      attach: vi.fn(),
      detach: vi.fn(),
      on: vi.fn((event, listener) => {
        debuggerEvents.on(event, listener)
      }),
      removeListener: vi.fn((event, listener) => {
        debuggerEvents.removeListener(event, listener)
      }),
      sendCommand: vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
        if (method === 'Page.setInterceptFileChooserDialog') {
          intercepting =
            typeof params === 'object' &&
            params !== null &&
            'enabled' in params &&
            params.enabled === true
        }
        return {}
      })
    }
    webContentsFromIdMock.mockReturnValue(guest)
    answerAgentBrowserCommands(execFileMock, stdinWrites, (command, cb) => {
      // Chromium shows the OS dialog unless interception is on when the page opens it.
      if (command[0] === 'click' && intercepting) {
        debuggerEvents.emit('message', {}, 'Page.fileChooserOpened', { backendNodeId: 7 })
      }
      if (command[0] === 'click') {
        onClick()
      }
      cb(null, JSON.stringify({ success: true, data: {} }), '')
    })
    bridge = new AgentBrowserBridge(mockBrowserManager())
    bridge.setActiveTab(100)
  })

  it('catches the picker instead of letting the OS dialog take over the screen', async () => {
    await expect(bridge.click('@e3')).rejects.toMatchObject({
      code: 'browser_file_chooser_opened'
    })
    expect(intercepting).toBe(false)
  })

  it("stops intercepting the desktop user's pickers when an SSH host loses the page mid-click", async () => {
    const revoked = new AbortController()
    onClick = () => revoked.abort()

    const click = runInRemoteCliBrowserScope(
      'workspace',
      () => bridge.click('@e3'),
      revoked.signal,
      () => true
    )

    await expect(click).rejects.toBeDefined()
    expect(intercepting).toBe(false)
  })
})
