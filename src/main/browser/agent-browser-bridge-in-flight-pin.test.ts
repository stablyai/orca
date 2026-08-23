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
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/app'), getAppPath: vi.fn(() => '/project'), isPackaged: false },
  webContents: { fromId: webContentsFromIdMock }
}))

const { CdpWsProxyMock, proxyStartGate } = vi.hoisted(() => {
  const instances: unknown[] = []
  const gate: { block: Promise<void> | null } = { block: null }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const MockClass = vi.fn().mockImplementation(function (this: any) {
    this.start = vi.fn(async () => {
      if (gate.block) {
        await gate.block
      }
      return 'ws://127.0.0.1:9222'
    })
    this.stop = vi.fn(async () => {})
    this.getPort = vi.fn(() => 9222)
    instances.push(this)
  })
  return { CdpWsProxyMock: Object.assign(MockClass, { instances }), proxyStartGate: gate }
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

// Why (STA-4341): the headless reclaimer parks pages it believes nobody is
// using, and asks the bridge. A command has to read as in flight for its whole
// lifetime — including helper-session setup, which can spend up to
// EXEC_TIMEOUT_MS (90s) closing a stale session, far longer than the reclaim
// grace window. Pinning only while the queue executes leaves that gap open.

describe('AgentBrowserBridge in-flight command pinning', () => {
  let bridge: AgentBrowserBridge

  beforeEach(() => {
    resetAgentBrowserBridgeMocks({
      webContentsFromIdMock,
      existsSyncMock,
      readFileSyncMock,
      stdinWrites,
      cdpWsProxyInstances: CdpWsProxyMock.instances
    })
    proxyStartGate.block = null
    bridge = new AgentBrowserBridge(mockBrowserManager())
    bridge.setActiveTab(100)
  })

  it('reports no in-flight command for an idle page', () => {
    expect(bridge.hasInFlightCommand('tab-1')).toBe(false)
  })

  it('pins the page while its helper session is still being set up', async () => {
    let releaseProxyStart = (): void => {}
    proxyStartGate.block = new Promise<void>((resolve) => (releaseProxyStart = resolve))
    succeedWith({ snapshot: 'ready' })

    const command = bridge.snapshot()
    // Yield so the command reaches session setup and blocks there.
    await Promise.resolve()
    await Promise.resolve()

    expect(bridge.hasInFlightCommand('tab-1')).toBe(true)

    releaseProxyStart()
    await command
    expect(bridge.hasInFlightCommand('tab-1')).toBe(false)
  })

  it('stays pinned until the last overlapping command finishes', async () => {
    let releaseProxyStart = (): void => {}
    proxyStartGate.block = new Promise<void>((resolve) => (releaseProxyStart = resolve))
    succeedWith({ snapshot: 'ready' })

    const first = bridge.snapshot()
    const second = bridge.snapshot()
    await Promise.resolve()
    expect(bridge.hasInFlightCommand('tab-1')).toBe(true)

    releaseProxyStart()
    await Promise.all([first, second])
    expect(bridge.hasInFlightCommand('tab-1')).toBe(false)
  })

  it('releases the pin when the command fails', async () => {
    execFileMock.mockImplementation(
      (_bin: string, _args: string[], _opts: unknown, cb: (e: unknown) => void) => {
        cb(new Error('boom'))
        return { stdin: { on: vi.fn(), end: vi.fn() } }
      }
    )

    await expect(bridge.snapshot()).rejects.toBeDefined()
    expect(bridge.hasInFlightCommand('tab-1')).toBe(false)
  })

  it('does not pin an unrelated page', async () => {
    succeedWith({ snapshot: 'ready' })
    const command = bridge.snapshot()
    expect(bridge.hasInFlightCommand('some-other-page')).toBe(false)
    await command
  })
})
