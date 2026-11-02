import { describe, it, expect, vi, beforeEach } from 'vitest'

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
vi.mock('../cdp-ws-proxy', () => ({ CdpWsProxy: CdpWsProxyMock }))

import { runInRemoteCliBrowserScope } from '../../runtime/desktop-browser-bridge/remote-cli-browser-scope'
import { runWithRequestedPageUrl } from '../browser-expected-page-url'
import { AgentBrowserBridge } from './agent-browser-bridge'
import {
  answerAgentBrowserCommands,
  mockBrowserManager,
  mockWebContents,
  overrideBridgeWebContentsLookup,
  resetAgentBrowserBridgeMocks,
  type ExecFileCallback,
  type MockWebContents
} from './agent-browser-bridge-test-harness'
import type { BrowserManager } from '../browser-manager'

overrideBridgeWebContentsLookup(AgentBrowserBridge.prototype, webContentsFromIdMock)

const A = 'https://chat.example/chat/a'
const B = 'https://chat.example/chat/b'
const PAGE = 'tab-1'

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

  it('refuses a same-origin route it was not meant for, with nothing sent to the page', async () => {
    url = B

    await expect(expecting(A, () => bridge.click('@e3'))).rejects.toMatchObject({
      code: 'browser_expected_url_mismatch',
      data: { expectedUrl: A, actualUrl: B, browserPageId: PAGE, mayHaveStarted: false }
    })

    expect(commands.filter(([name]) => name === 'click')).toEqual([])
  })

  it('acts on the expected URL and names the page and URL it checked', async () => {
    await expect(expecting(A, () => bridge.click('@e3'))).resolves.toMatchObject({
      browserPageId: PAGE,
      checkedUrl: A
    })

    expect(commands).toContainEqual(['click', '@e3'])
  })

  it('leaves a command without an expected URL unchecked and its result unchanged', async () => {
    url = B

    await expect(bridge.click('@e3')).resolves.toEqual({})

    expect(commands).toContainEqual(['click', '@e3'])
  })

  it('checks when its turn comes, not when it was asked', async () => {
    const finishAhead = holdHover()
    const ahead = bridge.hover('@e1')
    await vi.waitFor(() => expect(commands).toContainEqual(['hover', '@e1']))

    const queued = expecting(A, () => bridge.click('@e3'))
    url = B
    finishAhead()

    await expect(ahead).resolves.toBeDefined()
    await expect(queued).rejects.toMatchObject({
      code: 'browser_expected_url_mismatch',
      data: { actualUrl: B, mayHaveStarted: false }
    })
    expect(commands).not.toContainEqual(['click', '@e3'])
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

  it('checks the guest that replaced the page while the command waited', async () => {
    const finishAhead = holdHover()
    const tabs = new Map([[PAGE, 100]])
    bridge = new AgentBrowserBridge(
      mockBrowserManager(tabs, undefined, { getInFlightNavigationUrl: () => null })
    )
    bridge.setActiveTab(100)
    webContentsFromIdMock.mockImplementation((id: number) =>
      id === 200 ? mockWebContents(200, B) : guest
    )
    const ahead = bridge.hover('@e1', undefined, PAGE)
    await vi.waitFor(() => expect(commands).toContainEqual(['hover', '@e1']))

    const queued = expecting(A, () => bridge.goto(B, undefined, PAGE))
    tabs.set(PAGE, 200)
    finishAhead()

    await ahead
    await expect(queued).rejects.toMatchObject({
      code: 'browser_expected_url_mismatch',
      data: { actualUrl: B }
    })
  })

  it('fails as a closed page when the page goes away while the command waits', async () => {
    const finishAhead = holdHover()
    const ahead = bridge.hover('@e1')
    await vi.waitFor(() => expect(commands).toContainEqual(['hover', '@e1']))

    const queued = expecting(A, () => bridge.click('@e3'))
    webContentsFromIdMock.mockReturnValue(null)
    finishAhead()

    await ahead.catch(() => undefined)
    await expect(queued).rejects.toMatchObject({ code: 'browser_tab_not_found' })
    expect(commands).not.toContainEqual(['click', '@e3'])
  })

  it('refuses while the document is being replaced by a navigation elsewhere', async () => {
    inFlightUrl = B

    await expect(expecting(A, () => bridge.click('@e3'))).rejects.toMatchObject({
      data: { expectedUrl: A, actualUrl: B, mayHaveStarted: false }
    })
    expect(commands).not.toContainEqual(['click', '@e3'])
  })

  it('refuses while the outgoing document is still up on the way to the expected URL', async () => {
    url = B
    inFlightUrl = A

    await expect(expecting(A, () => bridge.click('@e3'))).rejects.toMatchObject({
      data: { actualUrl: B }
    })
  })

  it('rechecks between a fill reading its element and writing to it', async () => {
    const send = vi.spyOn(guest.debugger, 'sendCommand')
    answer = (command, cb) => {
      if (command[0] === 'get') {
        url = B
      }
      cb(null, JSON.stringify({ success: true, data: {} }), '')
    }

    await expect(expecting(A, () => bridge.fill('@e2', 'reply'))).rejects.toMatchObject({
      code: 'browser_expected_url_mismatch',
      data: { actualUrl: B, mayHaveStarted: true }
    })
    expect(send.mock.calls.filter(([method]) => method === 'Runtime.callFunctionOn')).toEqual([])
  })

  it('rechecks between typed runs, so keys after a navigating Enter never land', async () => {
    guest.debugger.sendCommand.mockImplementation(async (method, params) => {
      if (method === 'Input.dispatchKeyEvent' && (params as { key?: string }).key === 'Enter') {
        url = B
      }
      return {}
    })

    await expect(expecting(A, () => bridge.type('one\ntwo'))).rejects.toMatchObject({
      data: { actualUrl: B, mayHaveStarted: true }
    })

    const keys = guest.debugger.sendCommand.mock.calls
      .filter(([method]) => method === 'Input.dispatchKeyEvent')
      .map(([, params]) => (params as { key?: string }).key)
    expect(keys).toContain('Enter')
    expect(keys).not.toContain('t')
  })

  it('rechecks after finding where a guest’s keys go, right before they are sent', async () => {
    guest.getType.mockReturnValue('webview')
    guest.debugger.sendCommand.mockImplementation(async () => {
      url = B
      return {}
    })

    await expect(expecting(A, () => bridge.keypress('Enter'))).rejects.toMatchObject({
      data: { actualUrl: B, mayHaveStarted: false }
    })

    expect(guest.sendInputEvent).not.toHaveBeenCalled()
    expect(
      guest.debugger.sendCommand.mock.calls.filter(
        ([method]) => method === 'Input.dispatchKeyEvent'
      )
    ).toEqual([])
  })

  it('stops inserting chunks once the route moves', async () => {
    answer = (command, cb) => {
      if (command[1] === 'inserttext') {
        url = B
      }
      cb(null, JSON.stringify({ success: true, data: {} }), '')
    }

    await expect(
      expecting(A, () => bridge.keyboardInsertText('x'.repeat(9000)))
    ).rejects.toMatchObject({ data: { actualUrl: B, mayHaveStarted: true } })

    expect(commands.filter(([, sub]) => sub === 'inserttext')).toHaveLength(1)
  })

  it('reads what a navigating action caused after its own check has passed', async () => {
    bridge = makeBridge({
      beginAgentCommand: () => ({
        agent: true,
        run: (execute: () => Promise<unknown>) => execute(),
        end: () => {}
      }),
      observePageEvents: () => () => {}
    } as unknown as Partial<BrowserManager>)
    answer = (command, cb) => {
      if (command[0] === 'click') {
        url = B
      }
      cb(null, JSON.stringify({ success: true, data: { kind: 'delta', tree: 'changed' } }), '')
    }

    const result = await expecting(A, () => bridge.click('@e3'))

    expect(result).toMatchObject({ browserPageId: PAGE, checkedUrl: A, effects: { url: B } })
  }, 15_000)

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
    expect((failure as Error).message).not.toContain('secret')
  })

  it('checks a dialog answer before it reaches the page', async () => {
    url = B

    await expect(expecting(A, () => bridge.dialogAccept())).rejects.toMatchObject({
      code: 'browser_expected_url_mismatch',
      data: { actualUrl: B }
    })
  })
})
