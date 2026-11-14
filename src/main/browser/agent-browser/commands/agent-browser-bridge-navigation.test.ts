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

  it('frees the page queue when callers leave a never-settling evaluation', async () => {
    const wc = mockWebContents(100)
    wc.debugger.sendCommand
      .mockReturnValueOnce(new Promise(() => {}))
      .mockResolvedValue({ result: { value: 'example.com' } })
    webContentsFromIdMock.mockReturnValue(wc)
    const hungCaller = new AbortController()
    const queuedCaller = new AbortController()

    const hung = bridge.evaluate('new Promise(() => {})', undefined, undefined, hungCaller.signal)
    const queued = bridge.evaluate('sideEffect()', undefined, undefined, queuedCaller.signal)
    const next = bridge.evaluate('location.host')
    queuedCaller.abort()
    hungCaller.abort()

    await expect(hung).rejects.toThrow()
    await expect(queued).rejects.toThrow()
    await expect(next).resolves.toMatchObject({ result: 'example.com' })
    expect(wc.debugger.sendCommand).not.toHaveBeenCalledWith(
      'Runtime.evaluate',
      expect.objectContaining({ expression: 'sideEffect()' })
    )
  })

  it('deletes the named cookie through the guest debugger instead of clearing the profile', async () => {
    const spawns = succeedRecordingAgentBrowserSpawns(execFileMock, stdinWrites, { cleared: true })
    const wc = mockWebContents(100, 'https://www.example.com/app')
    wc.debugger.sendCommand.mockImplementation(async (method) =>
      method === 'Network.getAllCookies'
        ? { cookies: [{ name: 'sid', domain: '.example.com', path: '/' }] }
        : {}
    )
    webContentsFromIdMock.mockReturnValue(wc)

    await expect(bridge.cookieDelete('sid')).resolves.toEqual({ deleted: true })

    expect(wc.debugger.sendCommand).toHaveBeenCalledWith('Network.deleteCookies', {
      name: 'sid',
      domain: '.example.com',
      path: '/'
    })
    expect(spawns.map(({ command }) => command)).not.toContainEqual(
      expect.arrayContaining(['cookies', 'clear'])
    )
  })
})
