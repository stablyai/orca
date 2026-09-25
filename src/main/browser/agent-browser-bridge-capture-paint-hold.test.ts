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

  it('never holds paint for commands that do not capture pixels', async () => {
    const holdPaintForCapture = vi.fn(() => () => {})
    const printToPDF = vi.fn(async () => Buffer.from('pdf'))
    const b = new AgentBrowserBridge(
      mockBrowserManager(undefined, undefined, { holdPaintForCapture })
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
  })

  it('gives the helper proxy a paint hold scoped to its page', async () => {
    const release = vi.fn()
    const holdPaintForCapture = vi.fn(() => release)
    const b = new AgentBrowserBridge(
      mockBrowserManager(undefined, undefined, { holdPaintForCapture })
    )
    b.setActiveTab(100)
    webContentsFromIdMock.mockReturnValue(mockWebContents(100))

    succeedWith({ snapshot: 'tree' })
    await b.snapshot()

    const holdPaint = CdpWsProxyMock.mock.calls[0]?.[1]
    expect(holdPaint()).toBe(release)
    expect(holdPaintForCapture).toHaveBeenCalledWith(100)
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
