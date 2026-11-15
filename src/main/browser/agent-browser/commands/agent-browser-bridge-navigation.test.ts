import { EventEmitter } from 'node:events'
import type * as BrowserErrorTypes from '../../browser-error'
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
import { EMBEDDED_NAVIGATION_TIMEOUT_MS } from './agent-browser-navigation-settle'
import {
  mockBrowserManager,
  mockWebContents,
  overrideBridgeWebContentsLookup,
  resetAgentBrowserBridgeMocks,
  succeedRecordingAgentBrowserSpawns
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

  type EarlySettledNavigation = { commit: (url: string) => void; emit: (event: string) => void }

  // Electron resolves loadURL on the old page's beforeunload replaceState while the request is open.
  function mockEarlySettlingPage(
    url: string,
    settleLoad: (navigation: EarlySettledNavigation) => void
  ) {
    const wc = mockWebContents(100, url)
    const events = new EventEmitter()
    wc.on.mockImplementation((event, listener) => events.on(event, listener))
    wc.removeListener.mockImplementation((event, listener) =>
      events.removeListener(event, listener)
    )
    let committedUrl = url
    wc.getURL = () => committedUrl
    wc.loadURL.mockImplementation(async () => {
      wc.isWaitingForResponse.mockReturnValue(true)
      wc.isLoading.mockReturnValue(true)
      settleLoad({
        commit: (nextUrl) => {
          committedUrl = nextUrl
          wc.isWaitingForResponse.mockReturnValue(false)
          events.emit('did-navigate')
        },
        emit: (event) => events.emit(event)
      })
    })
    webContentsFromIdMock.mockReturnValue(wc)
    return wc
  }
})
