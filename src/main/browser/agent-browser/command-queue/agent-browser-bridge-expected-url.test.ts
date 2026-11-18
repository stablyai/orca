import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runInRemoteCliBrowserScope } from '../../../runtime/desktop-browser-bridge/remote-cli-browser-scope'
import { runWithRequestedPageUrl } from '../../cdp/input/browser-expected-page-url'
import { AgentBrowserBridge } from '../agent-browser-bridge'
import {
  answerAgentBrowserCommands,
  mockBrowserManager,
  mockWebContents,
  overrideBridgeWebContentsLookup,
  resetAgentBrowserBridgeMocks
} from '../testing/agent-browser-bridge-test-harness'
import type {
  ExecFileCallback,
  MockWebContents
} from '../testing/agent-browser-bridge-test-harness'
import type { BrowserManager } from '../../guest-lifecycle/manager/browser-manager'

const { execFileMock, webContentsFromIdMock, existsSyncMock, readFileSyncMock, stdinWrites } =
  vi.hoisted(() => ({
    execFileMock: vi.fn(),
    webContentsFromIdMock: vi.fn(),
    existsSyncMock: vi.fn(() => false),
    readFileSyncMock: vi.fn(() => Buffer.from('')),
    stdinWrites: new Array<string>()
  }))
const capturedElement = vi.hoisted(() => ({ objectId: 'object-1' }))

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
    this.elementCapture = { start: vi.fn(), stop: vi.fn(() => capturedElement) }
    instances.push(this)
  })
  return { CdpWsProxyMock: Object.assign(MockClass, { instances }) }
})
vi.mock('../../cdp/transport/cdp-ws-proxy', () => ({ CdpWsProxy: CdpWsProxyMock }))

overrideBridgeWebContentsLookup(AgentBrowserBridge.prototype, webContentsFromIdMock)

const A = 'https://chat.example/chat/a'
const B = 'https://chat.example/chat/b'

const expecting = <T>(url: string, run: () => T): T =>
  runWithRequestedPageUrl({ expectUrl: url }, run)

describe('commands that expect a page URL', () => {
  let guest: MockWebContents
  let url: string
  let commands: string[][]
  let inFlightUrl: string | null
  let answer: (command: string[], cb: ExecFileCallback) => void
  let bridge: AgentBrowserBridge

  /** Keeps a hover on the page queue until the returned function runs. */
  const holdHover = (): (() => void) => {
    let finish = (): void => {}
    answer = (command, cb) => {
      const reply = (): void => cb(null, JSON.stringify({ success: true, data: {} }), '')
      if (command[0] === 'hover') {
        finish = reply
      } else {
        reply()
      }
    }
    return () => finish()
  }

  const makeBridge = (overrides: Partial<BrowserManager> = {}): AgentBrowserBridge => {
    const made = new AgentBrowserBridge(
      mockBrowserManager(undefined, undefined, {
        getInFlightNavigationUrl: () => inFlightUrl,
        ...overrides
      })
    )
    made.setActiveTab(100)
    return made
  }

  beforeEach(() => {
    resetAgentBrowserBridgeMocks({
      webContentsFromIdMock,
      existsSyncMock,
      readFileSyncMock,
      stdinWrites,
      cdpWsProxyInstances: CdpWsProxyMock.instances
    })
    url = A
    inFlightUrl = null
    guest = { ...mockWebContents(100), getURL: () => url }
    webContentsFromIdMock.mockReturnValue(guest)
    commands = []
    answer = (_command, cb) => cb(null, JSON.stringify({ success: true, data: {} }), '')
    answerAgentBrowserCommands(execFileMock, stdinWrites, (command, cb) => {
      commands.push(command)
      answer(command, cb)
    })
    bridge = makeBridge()
  })

  it('keeps each queued command to its own expected URL', async () => {
    const finishAhead = holdHover()
    // This caller's scope is the one the queue keeps running under for everything behind it.
    const ahead = expecting(A, () => bridge.hover('@e1'))
    await vi.waitFor(() => expect(commands).toContainEqual(['hover', '@e1']))

    const unguarded = bridge.click('@unguarded')
    const guardedElsewhere = expecting(B, () => bridge.click('@elsewhere'))
    finishAhead()

    await expect(ahead).resolves.toBeDefined()
    await expect(unguarded).resolves.toEqual({})
    await expect(guardedElsewhere).rejects.toMatchObject({
      data: { expectedUrl: B, actualUrl: A }
    })
    expect(commands).toContainEqual(['click', '@unguarded'])
    expect(commands).not.toContainEqual(['click', '@elsewhere'])
  })

  it('does not tell an SSH host the URL of a page that moved somewhere it may not drive', async () => {
    const SECRET = 'file:///Users/me/secret.pdf'
    // The last await before the input goes out.
    bridge = makeBridge({
      showAgentPointer: async () => {
        url = SECRET
      }
    })

    const failure = await runInRemoteCliBrowserScope(
      'workspace',
      () => expecting(A, () => bridge.mouseMove(1, 2)),
      undefined,
      () => url !== SECRET
    ).catch((error: unknown) => error)

    expect(failure).toMatchObject({ code: 'desktop_browser_bridge_unrouted' })
    expect(JSON.stringify(failure)).not.toContain('secret')
    expect(String(failure)).not.toContain('secret')
  })
})
