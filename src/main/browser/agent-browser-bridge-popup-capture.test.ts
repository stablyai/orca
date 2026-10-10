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
  type ExecFileCallback,
  type MockWebContents
} from './agent-browser-bridge-test-harness'

overrideBridgeWebContentsLookup(AgentBrowserBridge.prototype, webContentsFromIdMock)

// Why: agent-browser 0.27 `network requests` returns {requests:[...]} with
// epoch-ms timestamps — the fixture copies that wire shape, including the
// opener's verbatim query string, which this patch leaves alone.
const OPENER_ITEM = {
  requestId: 'daemon-req-1',
  url: 'https://opener.example/app?session=keep-me',
  method: 'GET',
  headers: { accept: 'text/html' },
  timestamp: 1780000000000,
  resourceType: 'Document',
  status: 200,
  mimeType: 'text/html'
}

function respondToDaemonCommands(): void {
  execFileMock.mockImplementation(
    (_bin: string, args: string[], _opts: unknown, cb: ExecFileCallback) => {
      if (args.includes('close')) {
        cb(null, JSON.stringify({ success: true, data: null }), '')
        return { stdin: { on: vi.fn(), end: vi.fn() } }
      }
      if (args.includes('requests')) {
        cb(null, JSON.stringify({ success: true, data: { requests: [OPENER_ITEM] } }), '')
        return { stdin: { on: vi.fn(), end: vi.fn() } }
      }
      const leaf = args.at(-2)
      const data =
        leaf === 'start' ? { capturing: true } : leaf === 'stop' ? { stopped: true } : { ok: true }
      cb(null, JSON.stringify({ success: true, data }), '')
      return { stdin: { on: vi.fn(), end: vi.fn() } }
    }
  )
}

function emitPopupDebuggerMessage(popup: MockWebContents, method: string, params: unknown): void {
  const call = popup.debugger.on.mock.calls.find(([event]) => event === 'message')
  expect(call).toBeDefined()
  // Why Reflect.apply: the shared mock types listeners as (...args: never[]), so a
  // direct call cannot pass the CDP method and params the listener provably receives.
  Reflect.apply(call![1], null, [{}, method, params])
}

function emitPopupResponse(popup: MockWebContents): void {
  emitPopupDebuggerMessage(popup, 'Network.requestWillBeSent', {
    requestId: 'popup-req-1',
    request: { url: 'https://popup.example/healthz?code=SECRET', method: 'POST' },
    timestamp: 1.5
  })
  emitPopupDebuggerMessage(popup, 'Network.responseReceived', {
    requestId: 'popup-req-1',
    response: {
      url: 'https://popup.example/healthz?code=SECRET&state=x#frag',
      status: 201,
      mimeType: 'application/json'
    },
    type: 'XHR',
    timestamp: 1.6
  })
  emitPopupDebuggerMessage(popup, 'Network.loadingFinished', {
    requestId: 'popup-req-1',
    encodedDataLength: 12
  })
}

function messageListenerCount(popup: MockWebContents): number {
  return popup.debugger.on.mock.calls.filter(([event]) => event === 'message').length
}

describe('AgentBrowserBridge popup capture', () => {
  let popup: MockWebContents

  beforeEach(() => {
    resetAgentBrowserBridgeMocks({
      webContentsFromIdMock,
      existsSyncMock,
      readFileSyncMock,
      stdinWrites,
      cdpWsProxyInstances: CdpWsProxyMock.instances
    })
    const opener = mockWebContents(100, 'https://opener.example/app', 'Opener')
    popup = mockWebContents(200, 'https://popup.example/healthz', 'Popup')
    // Why: Electron's debugger.sendCommand always returns a promise — the mock
    // must honor that contract or the production .catch chain throws in tests.
    popup.debugger.sendCommand.mockResolvedValue({})
    webContentsFromIdMock.mockImplementation((id: number) =>
      id === 100 ? opener : id === 200 ? popup : null
    )
    respondToDaemonCommands()
  })

  function bridgeWithOpener(): AgentBrowserBridge {
    const bridge = new AgentBrowserBridge(mockBrowserManager())
    bridge.setActiveTab(100)
    return bridge
  }

  it('merges opener and popup requests exactly once into the daemon requests shape', async () => {
    const bridge = bridgeWithOpener()
    await bridge.captureStart(undefined, 'tab-1')

    // Why: prepareContent notifies before the popup's first navigation — the
    // bridge attaches while capturing, so the initial request is recorded.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shared mock implements the debugger surface the bridge exercises (on/removeListener/sendCommand/isDestroyed), which is all onPopupOpened touches.
    bridge.onPopupOpened('tab-1', popup as never)
    emitPopupResponse(popup)

    const result = await bridge.networkLog(undefined, undefined, 'tab-1')
    expect(result).not.toHaveProperty('entries')
    expect(result.requests).toHaveLength(2)
    expect(result.requests[0]).toEqual(OPENER_ITEM)
    // Popup entries hide query and fragment but keep origin, path and method.
    expect(result.requests[1]).toEqual({
      requestId: 'popup-req-1',
      url: 'https://popup.example/healthz',
      method: 'POST',
      timestamp: expect.any(Number),
      resourceType: 'XHR',
      status: 201,
      mimeType: 'application/json'
    })
    expect(result.requests[1].timestamp).toBeGreaterThan(1_000_000_000_000)
  })

  it('keeps a closed popup request readable until capture stop', async () => {
    const bridge = bridgeWithOpener()
    await bridge.captureStart(undefined, 'tab-1')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shared mock implements the debugger surface the bridge exercises (on/removeListener/sendCommand/isDestroyed), which is all onPopupOpened touches.
    bridge.onPopupOpened('tab-1', popup as never)
    emitPopupResponse(popup)

    bridge.onPopupClosed(200)
    expect(popup.debugger.removeListener).toHaveBeenCalledWith('message', expect.anything())
    expect((await bridge.networkLog(undefined, undefined, 'tab-1')).requests).toHaveLength(2)

    await bridge.captureStop(undefined, 'tab-1')
    expect((await bridge.networkLog(undefined, undefined, 'tab-1')).requests).toEqual([OPENER_ITEM])
  })

  it('preserves live popup registration across session reset and stops recording', async () => {
    const bridge = bridgeWithOpener()
    await bridge.captureStart(undefined, 'tab-1')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shared mock implements the debugger surface the bridge exercises (on/removeListener/sendCommand/isDestroyed), which is all onPopupOpened touches.
    bridge.onPopupOpened('tab-1', popup as never)
    emitPopupResponse(popup)
    expect(messageListenerCount(popup)).toBe(1)

    await bridge.onProcessSwap('tab-1', 100, 100)
    // The restarted session no longer captures, so popup entries stop merging.
    expect((await bridge.networkLog(undefined, undefined, 'tab-1')).requests).toEqual([OPENER_ITEM])

    // The still-open popup is still registered: the next capture reattaches it.
    await bridge.captureStart(undefined, 'tab-1')
    expect(messageListenerCount(popup)).toBe(2)
    emitPopupResponse(popup)
    expect((await bridge.networkLog(undefined, undefined, 'tab-1')).requests).toHaveLength(2)
  })

  it('releases popup capture on opener retirement', async () => {
    const bridge = bridgeWithOpener()
    await bridge.captureStart(undefined, 'tab-1')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shared mock implements the debugger surface the bridge exercises (on/removeListener/sendCommand/isDestroyed), which is all onPopupOpened touches.
    bridge.onPopupOpened('tab-1', popup as never)
    emitPopupResponse(popup)

    await bridge.onPageClosed('tab-1')
    expect(popup.debugger.removeListener).toHaveBeenCalledWith('message', expect.anything())
    expect((await bridge.networkLog(undefined, undefined, 'tab-1')).requests).toEqual([OPENER_ITEM])
  })
})
