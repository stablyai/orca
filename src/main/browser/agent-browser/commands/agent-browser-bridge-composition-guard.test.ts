import type * as BrowserErrorTypes from '../../browser-error'
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'

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
vi.mock('../../cdp/transport/cdp-ws-proxy', () => ({ CdpWsProxy: CdpWsProxyMock }))
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

import { BrowserError } from '../../browser-error'
import { AgentBrowserBridge, passthroughMovesPageFocus } from '../agent-browser-bridge'
import { parseShellArgs } from '../../../../shared/shell-args'
import {
  mockBrowserManager,
  mockWebContents,
  overrideBridgeWebContentsLookup,
  resetAgentBrowserBridgeMocks,
  succeedRecordingAgentBrowserSpawns,
  type MockWebContents
} from '../testing/agent-browser-bridge-test-harness'

overrideBridgeWebContentsLookup(AgentBrowserBridge.prototype, webContentsFromIdMock)

const FOCUSING_SCRIPT = 'document.getElementById("notes").focus()'

// Page script that moves focus in a background tab discards the user's macOS IME composition (Chromium 150).
describe('agent page script while the user composes', () => {
  let guard: Mock<(guestWebContentsId: number) => Promise<() => void>>
  let bridge: AgentBrowserBridge
  let wc: MockWebContents

  beforeEach(() => {
    resetAgentBrowserBridgeMocks({
      webContentsFromIdMock,
      existsSyncMock,
      readFileSyncMock,
      stdinWrites,
      cdpWsProxyInstances: CdpWsProxyMock.instances
    })
    guard = vi.fn<(guestWebContentsId: number) => Promise<() => void>>()
    bridge = new AgentBrowserBridge(
      mockBrowserManager(undefined, undefined, { guardUserFocusForAgentInput: guard })
    )
    bridge.setActiveTab(100)
    wc = mockWebContents(100)
    wc.getType.mockReturnValue('webview')
    wc.debugger.sendCommand.mockResolvedValue({ result: { value: 'ok' } })
    webContentsFromIdMock.mockReturnValue(wc)
  })

  const composing = (): Promise<never> =>
    Promise.reject(new BrowserError('browser_user_composing', 'The user is typing'))

  it('refuses an eval and never sends it to the page', async () => {
    guard.mockImplementation(composing)

    await expect(bridge.evaluate(FOCUSING_SCRIPT)).rejects.toMatchObject({
      code: 'browser_user_composing'
    })
    expect(wc.debugger.sendCommand).not.toHaveBeenCalledWith('Runtime.evaluate', expect.anything())
    // Page script never takes the window's focus, so the pane is only asked, not told to hold focus.
    expect(guard).toHaveBeenCalledWith(100, { holdFocus: false })
  })

  it('never sends the eval of a caller that left while the pane answered', async () => {
    let answer: (release: () => void) => void = () => {}
    guard.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    const release = vi.fn()
    const caller = new AbortController()

    const result = bridge.evaluate(FOCUSING_SCRIPT, undefined, undefined, caller.signal)
    await vi.waitFor(() => expect(guard).toHaveBeenCalled())
    caller.abort()
    answer(release)

    await expect(result).rejects.toMatchObject({ message: expect.stringContaining('aborted') })
    expect(release).toHaveBeenCalled()
    expect(wc.debugger.sendCommand).not.toHaveBeenCalledWith('Runtime.evaluate', expect.anything())
  })

  it('refuses an eval when the pane cannot answer, as a click is', async () => {
    guard.mockRejectedValue(new BrowserError('browser_focus_guard_unavailable', 'no answer'))

    await expect(bridge.evaluate('location.host')).rejects.toMatchObject({
      code: 'browser_focus_guard_unavailable'
    })
    expect(wc.debugger.sendCommand).not.toHaveBeenCalledWith('Runtime.evaluate', expect.anything())
  })

  it('refuses a raw focus before the helper runs it', async () => {
    const spawns = succeedRecordingAgentBrowserSpawns(execFileMock, stdinWrites, {})
    guard.mockImplementation(composing)

    await expect(bridge.exec('focus #notes')).rejects.toMatchObject({
      code: 'browser_user_composing'
    })
    expect(spawns.map(({ command }) => command)).not.toContainEqual(
      expect.arrayContaining(['focus'])
    )
  })

  it("refuses a found element's fill and a wait --fn condition, but not a find that reads", async () => {
    const spawns = succeedRecordingAgentBrowserSpawns(execFileMock, stdinWrites, {})
    guard.mockImplementation(composing)

    await expect(bridge.find('label', 'Email', 'fill', 'x')).rejects.toMatchObject({
      code: 'browser_user_composing'
    })
    await expect(bridge.wait({ fn: FOCUSING_SCRIPT })).rejects.toMatchObject({
      code: 'browser_user_composing'
    })
    await expect(bridge.find('label', 'Email', 'text')).resolves.toEqual({})
    const commands = spawns.map(({ command }) => command)
    expect(commands).not.toContainEqual(expect.arrayContaining(['find', 'fill']))
    expect(commands).not.toContainEqual(expect.arrayContaining(['--fn']))
    expect(commands).toContainEqual(expect.arrayContaining(['find', 'text']))
  })
})

// The proxy already guards the helper's mouse presses and Tab, so `click` and `press Tab` stay out.
describe('passthroughMovesPageFocus', () => {
  it.each([
    ['eval document.body.focus()', true],
    ['fill #probe agent', true],
    ['type #probe agent', true],
    ['focus #notes', true],
    ['batch "click #a" "eval 1"', true],
    ['pushstate /settings', true],
    ['webmcp invoke search', true],
    ['flow run checkout', true],
    ['webmcp list', false],
    ['flow steps', false],
    ['find label Email fill x', true],
    ['find label Email click', false],
    ['find label fill text', false],
    ['find label --account fill x', true],
    ['find nth 2 a fill x', true],
    ['find nth 2 fill click', false],
    ['find role textbox --name Email fill x', true],
    ['find label Email', false],
    ['wait --fn "document.body.focus()"', true],
    ['wait "#notes"', false],
    ['wait --fn=document.body.focus()', true],
    ['press Tab', false],
    ['press Enter', false],
    ['keyboard type hello', false],
    ['get text #notes', false],
    ['snapshot -i', false],
    ['reload', false],
    ['click #target', false]
  ])('%s → %s', (command, expected) => {
    expect(passthroughMovesPageFocus(parseShellArgs(command))).toBe(expected)
  })
})
