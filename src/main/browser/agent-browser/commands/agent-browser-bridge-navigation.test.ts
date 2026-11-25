import type * as BrowserErrorTypes from '../../browser-error'
import { describe, it, expect, vi, beforeEach } from 'vitest'

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
vi.mock('../../browser-error', () => ({
  BrowserError: class BrowserError extends Error {
    code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  }
}))

vi.mock('../../cdp/commands/cdp-bridge', async () => {
  const { BrowserError } = await vi.importMock<typeof BrowserErrorTypes>('../../browser-error')
  return { BrowserError }
})

import { AgentBrowserBridge } from '../agent-browser-bridge'

import {
  mockBrowserManager,
  mockWebContents,
  overrideBridgeWebContentsLookup,
  resetAgentBrowserBridgeMocks
} from '../testing/agent-browser-bridge-test-harness'

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

  it('redacts discovery and navigation replies while delivering the raw private target to its guest', async () => {
    const raw = 'https://kagi.com/search?q=one&token=test-only'
    const wc = mockWebContents(100, raw, raw)
    webContentsFromIdMock.mockReturnValue(wc)
    const manager = mockBrowserManager(new Map([['tab-1', 100]]), new Map(), {
      getBrowserPageLoadError: () => ({
        code: -20,
        description: 'ERR_BLOCKED_BY_CLIENT',
        validatedUrl: raw
      })
    })
    const privateBridge = new AgentBrowserBridge(manager)
    expect(privateBridge.tabList().tabs[0]).toMatchObject({
      url: 'https://kagi.com/search?q=one',
      title: 'https://kagi.com/search?q=one',
      loadError: { validatedUrl: 'https://kagi.com/search?q=one' }
    })
    expect(privateBridge.getPageInfo(undefined, 'tab-1')).toEqual({
      browserPageId: 'tab-1',
      url: 'https://kagi.com/search?q=one',
      title: 'https://kagi.com/search?q=one'
    })
    expect(await privateBridge.goto(raw, undefined, 'tab-1', { reportEffects: false })).toEqual({
      url: 'https://kagi.com/search?q=one',
      title: 'https://kagi.com/search?q=one'
    })
    expect(wc.loadURL).toHaveBeenCalledWith(raw)
    // Stop is not queued and reads the committed page directly, so it needs its own redaction.
    const stop = vi.fn()
    Object.assign(wc, { stop })
    expect(privateBridge.stop(undefined, 'tab-1')).toEqual({
      url: 'https://kagi.com/search?q=one',
      title: 'https://kagi.com/search?q=one'
    })
    expect(stop).toHaveBeenCalled()
  })

  it('keeps target-bearing Kagi failures out of replies but retains ordinary failure diagnostics', async () => {
    const raw = 'https://kagi.com/search?q=one&token=test-only'
    const wc = mockWebContents(100)
    webContentsFromIdMock.mockReturnValue(wc)
    wc.loadURL.mockRejectedValue(new Error(`ERR_BLOCKED_BY_CLIENT (-20) loading '${raw}'`))
    await expect(bridge.goto(raw, undefined, 'tab-1', { reportEffects: false })).rejects.toThrow(
      'Private navigation failed.'
    )
    wc.loadURL.mockRejectedValue(
      Object.assign(new Error(`ERR_BLOCKED_BY_CLIENT loading '${raw}'`), { url: raw })
    )
    await expect(
      bridge.goto('https://example.com/start', undefined, 'tab-1', { reportEffects: false })
    ).rejects.toThrow('Private navigation failed.')
    wc.loadURL.mockRejectedValue(
      new Error('ERR_CONNECTION_REFUSED (-102) loading https://example.com/')
    )
    await expect(
      bridge.goto('https://example.com/', undefined, 'tab-1', { reportEffects: false })
    ).rejects.toThrow('ERR_CONNECTION_REFUSED (-102) loading https://example.com/')
  })

  // Electron resolves loadURL on the old page's beforeunload replaceState while the request is open.
})
