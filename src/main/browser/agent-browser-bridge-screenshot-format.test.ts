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
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/app'), getAppPath: vi.fn(() => '/project'), isPackaged: false },
  webContents: { fromId: webContentsFromIdMock }
}))
const { CdpWsProxyMock } = vi.hoisted(() => {
  class MockCdpWsProxy {
    static instances: unknown[] = []
    start = vi.fn(async () => 'ws://127.0.0.1:9222')
    stop = vi.fn(async () => {})
    getPort = vi.fn(() => 9222)

    constructor(_wc: unknown) {
      MockCdpWsProxy.instances.push(this)
    }
  }
  return { CdpWsProxyMock: MockCdpWsProxy }
})

vi.mock('./cdp-ws-proxy', () => ({ CdpWsProxy: CdpWsProxyMock }))
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
  overrideBridgeWebContentsLookup,
  resetAgentBrowserBridgeMocks
} from './agent-browser-bridge-test-harness'

overrideBridgeWebContentsLookup(AgentBrowserBridge.prototype, webContentsFromIdMock)

const succeedWith = createSucceedWith(execFileMock, stdinWrites)

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function screenshotArgs(): string[] {
  const screenshotCall = execFileMock.mock.calls.find(
    (call) => Array.isArray(call) && isStringArray(call[1]) && call[1].includes('screenshot')
  )
  if (!screenshotCall || !isStringArray(screenshotCall[1])) {
    throw new Error('Expected agent-browser screenshot arguments')
  }
  return screenshotCall[1]
}

describe('AgentBrowserBridge viewport screenshot formats', () => {
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

  it('forwards JPEG encoding and returns matching JPEG bytes and metadata', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(jpeg)
    succeedWith({ path: '/tmp/capture.jpeg' })

    const result = await bridge.screenshot('jpeg')

    expect(result).toEqual({
      data: jpeg.toString('base64'),
      format: 'jpeg'
    })
    expect(Buffer.from(result.data, 'base64')).toEqual(jpeg)

    expect(screenshotArgs()).toEqual(
      expect.arrayContaining(['screenshot', '--screenshot-format', 'jpeg'])
    )
    expect(screenshotArgs().slice(-4)).toEqual([
      'screenshot',
      '--screenshot-format',
      'jpeg',
      '--json'
    ])
    expect(screenshotArgs()).not.toContain('--screenshot-quality')
  })

  it.each([
    ['png', 'explicit PNG'],
    [undefined, 'an omitted format'],
    ['webp', 'an unsupported format']
  ])('normalizes %s to PNG for %s', async (requestedFormat, _description) => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(png)
    succeedWith({ path: '/tmp/capture.png' })

    const result = await bridge.screenshot(requestedFormat)

    expect(result).toEqual({
      data: png.toString('base64'),
      format: 'png'
    })
    expect(Buffer.from(result.data, 'base64')).toEqual(png)

    expect(screenshotArgs().slice(-4)).toEqual([
      'screenshot',
      '--screenshot-format',
      'png',
      '--json'
    ])
  })
})
