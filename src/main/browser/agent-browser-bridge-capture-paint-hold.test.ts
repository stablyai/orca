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
  createSucceedWith,
  mockBrowserManager,
  mockWebContents,
  overrideBridgeWebContentsLookup,
  resetAgentBrowserBridgeMocks,
  type ExecFileCallback
} from './agent-browser-bridge-test-harness'

overrideBridgeWebContentsLookup(AgentBrowserBridge.prototype, webContentsFromIdMock)

const succeedWith = createSucceedWith(execFileMock, stdinWrites)

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

  it('holds only the guest, never paint, for commands that do not capture pixels', async () => {
    const releases: ReturnType<typeof vi.fn>[] = []
    const holdGuestActive = vi.fn(() => {
      const release = vi.fn()
      releases.push(release)
      return release
    })
    const holdPaintForCapture = vi.fn(() => () => {})
    const printToPDF = vi.fn(async () => Buffer.from('pdf'))
    const b = new AgentBrowserBridge(
      mockBrowserManager(undefined, undefined, { holdGuestActive, holdPaintForCapture })
    )
    b.setActiveTab(100)
    webContentsFromIdMock.mockReturnValue({ ...mockWebContents(100), printToPDF })

    succeedWith({ snapshot: 'tree' })
    await b.snapshot()
    await b.click('@e1')
    await b.mouseClick(10, 20)
    await b.exec('get title')
    await expect(b.pdf()).resolves.toEqual({ data: Buffer.from('pdf').toString('base64') })

    expect(holdPaintForCapture).not.toHaveBeenCalled()
    expect(holdGuestActive.mock.calls).toEqual([[100], [100], [100], [100], [100]])
    expect(releases.map((release) => release.mock.calls.length)).toEqual([1, 1, 1, 1, 1])
  })

  it('holds only executing commands and resolves a queued command against the replacement guest', async () => {
    const tabs = new Map([['tab-1', 100]])
    const holds: number[] = []
    const released: number[] = []
    const b = new AgentBrowserBridge(
      mockBrowserManager(tabs, undefined, {
        holdGuestActive: (id) => {
          holds.push(id)
          return () => released.push(id)
        }
      })
    )
    const oldGuest = mockWebContents(100)
    const replacement = mockWebContents(200)
    let finish = (_value: unknown): void => {}
    oldGuest.debugger.sendCommand.mockImplementation(
      () => new Promise((resolve) => (finish = resolve))
    )
    replacement.debugger.sendCommand.mockResolvedValue({ result: { value: 'replacement' } })
    webContentsFromIdMock.mockImplementation((id: number) => (id === 100 ? oldGuest : replacement))
    b.setActiveTab(100)

    const first = b.evaluate('first', undefined, 'tab-1')
    const firstResult = expect(first).rejects.toMatchObject({ code: 'browser_tab_changed' })
    const second = b.evaluate('second', undefined, 'tab-1')
    const holdsWhileQueued = [...holds]
    expect(released).toEqual([])
    tabs.set('tab-1', 200)
    finish({ result: { value: 'old' } })

    await firstResult
    await expect(second).resolves.toMatchObject({ result: 'replacement' })
    expect(holdsWhileQueued).toEqual([100])
    expect(holds).toEqual([100, 200])
    expect(released).toEqual([100, 200])
  })

  it('drops queued commands without acquiring the guest and holds running work until it settles', async () => {
    const release = vi.fn()
    const holdGuestActive = vi.fn(() => release)
    const b = new AgentBrowserBridge(mockBrowserManager(undefined, undefined, { holdGuestActive }))
    b.setActiveTab(100)
    const guest = mockWebContents(100)
    let finish = (_value: unknown): void => {}
    guest.debugger.sendCommand.mockImplementation(
      () => new Promise((resolve) => (finish = resolve))
    )
    webContentsFromIdMock.mockReturnValue(guest)

    const running = b.evaluate('first')
    const queued = b.evaluate('second')
    const queuedResult = expect(queued).rejects.toMatchObject({ code: 'browser_tab_closed' })
    await b.onPageClosed('tab-1')
    await queuedResult
    expect(holdGuestActive.mock.calls).toEqual([[100]])
    expect(release).not.toHaveBeenCalled()

    finish({ result: { value: 'finished' } })
    await running
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('releases the background hold when session setup fails', async () => {
    const release = vi.fn()
    const holdGuestActive = vi.fn(() => release)
    const b = new AgentBrowserBridge(mockBrowserManager(undefined, undefined, { holdGuestActive }))
    b.setActiveTab(100)
    CdpWsProxyMock.mockImplementationOnce(function (this: Record<string, unknown>) {
      this.start = vi.fn(async () => {
        throw new Error('cannot start proxy')
      })
    })
    succeedWith(null)

    await expect(b.snapshot()).rejects.toThrow('cannot start proxy')
    expect(holdGuestActive).toHaveBeenCalledWith(100)
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('captures full-page screenshots directly through CDP using CSS layout bounds', async () => {
    const wc = mockWebContents(100)
    wc.debugger.sendCommand.mockImplementation((method: string) => {
      if (method === 'Page.getLayoutMetrics') {
        return Promise.resolve({
          cssContentSize: { width: 600.2, height: 900.4 },
          contentSize: { width: 1200.4, height: 1800.8 }
        })
      }
      if (method === 'Page.captureScreenshot') {
        return Promise.resolve({ data: 'full-cdp-shot' })
      }
      return Promise.resolve({})
    })
    webContentsFromIdMock.mockReturnValue(wc)

    execFileMock.mockImplementation(
      (_bin: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
        cb(null, JSON.stringify({ success: true, data: null }), '')
      }
    )

    const release = vi.fn()
    const holdPaintForCapture = vi.fn(() => release)
    const b = new AgentBrowserBridge(
      mockBrowserManager(undefined, undefined, { holdPaintForCapture })
    )
    b.setActiveTab(100)

    await expect(b.fullPageScreenshot('png')).resolves.toEqual({
      data: 'full-cdp-shot',
      format: 'png'
    })

    expect(wc.debugger.sendCommand).toHaveBeenNthCalledWith(1, 'Page.getLayoutMetrics', {})
    expect(wc.debugger.sendCommand).toHaveBeenNthCalledWith(2, 'Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: 601, height: 901, scale: 1 }
    })
    expect(holdPaintForCapture).toHaveBeenCalledWith(100)
    expect(release).toHaveBeenCalledTimes(1)
    const screenshotCall = execFileMock.mock.calls.find((call: unknown[]) =>
      (call[1] as string[]).includes('screenshot')
    )
    expect(screenshotCall).toBeUndefined()
  })
})
