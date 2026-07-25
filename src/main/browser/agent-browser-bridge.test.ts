/* eslint-disable max-lines */
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

import {
  AGENT_BROWSER_CLIPBOARD_WRITE_MAX_BYTES,
  AGENT_BROWSER_TEXT_ARGUMENT_MAX_BYTES,
  AgentBrowserBridge
} from './agent-browser-bridge'
import type { BrowserManager } from './browser-manager'
import {
  CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS,
  CLIPBOARD_TEXT_WRITE_MAX_BYTES,
  CLIPBOARD_TEXT_WRITE_TOO_LARGE_ERROR
} from '../../shared/clipboard-text'

// Why: the bridge resolves webContents via dynamic require('electron').webContents.fromId
// inside a try/catch. Override the private method to inject our mock.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(AgentBrowserBridge.prototype as any).getWebContents = function (id: number) {
  const target = webContentsFromIdMock(id)
  return target && !target.isDestroyed() ? target : null
}

function mockBrowserManager(
  tabs: Map<string, number> = new Map([['tab-1', 100]]),
  worktrees: Map<string, string> = new Map(),
  overrides: Partial<BrowserManager> = {}
): BrowserManager {
  return {
    getWebContentsIdByTabId: () => tabs,
    getWorktreeIdForTab: (tabId: string) => worktrees.get(tabId),
    getGuestWebContentsId: vi.fn(() => null),
    getBrowserPageLoadError: vi.fn(() => null),
    getBrowserPageCertificateFailure: vi.fn(() => null),
    unregisterGuest: vi.fn(),
    ensureWebviewVisible: vi.fn(async () => () => {}),
    acquireAutomationVisibility: vi.fn(async () => () => {}),
    ...overrides
  } as unknown as BrowserManager
}

function mockWebContents(id: number, url = 'https://example.com', title = 'Example') {
  let currentUrl = url
  return {
    id,
    getURL: () => currentUrl,
    getTitle: () => title,
    loadURL: vi.fn(async (nextUrl: string) => {
      currentUrl = nextUrl
    }),
    isLoading: vi.fn(() => false),
    on: vi.fn(),
    removeListener: vi.fn(),
    isDestroyed: () => false,
    invalidate: vi.fn(),
    focus: vi.fn(),
    debugger: {
      isAttached: vi.fn(() => true),
      attach: vi.fn(),
      detach: vi.fn(),
      sendCommand: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn()
    }
  }
}

function succeedWith(data: unknown): void {
  execFileMock.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: Function) => {
    cb(null, JSON.stringify({ success: true, data }), '')
    return {
      stdin: { on: vi.fn(), end: (text: string) => stdinWrites.push(text) }
    }
  })
}

function succeedForContentEditable(data: unknown = { ok: true }): void {
  execFileMock.mockImplementation((_bin: string, args: string[], _opts: unknown, cb: Function) => {
    const result =
      args.includes('get') && args.includes('attr') && args.includes('contenteditable')
        ? { value: 'true' }
        : data
    cb(null, JSON.stringify({ success: true, data: result }), '')
    return {
      stdin: { on: vi.fn(), end: (text: string) => stdinWrites.push(text) }
    }
  })
}

function failWith(error: string): void {
  execFileMock.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: Function) => {
    cb(null, JSON.stringify({ success: false, error }), '')
  })
}

class TestEvent {
  type: string
  bubbles: boolean

  constructor(type: string, init?: { bubbles?: boolean }) {
    this.type = type
    this.bubbles = init?.bubbles ?? false
  }
}

type FillEvalNode = {
  tagName: string
  getAttribute: (name: string) => string | null
  matches: (selector: string) => boolean
  querySelector?: (selector: string) => FillEvalNode | null
  dispatchEvent: (event: TestEvent) => boolean
  value: string
}

function matchesFillEvalSelector(node: FillEvalNode, selector: string): boolean {
  return selector.split(',').some((candidate) => {
    const trimmed = candidate.trim()
    if (trimmed === 'textarea') {
      return node.tagName === 'TEXTAREA'
    }
    if (!trimmed.startsWith('input') || node.tagName !== 'INPUT') {
      return false
    }
    const excludedTypes = [...trimmed.matchAll(/:not\(\[type='([^']+)'\]\)/g)].map((match) =>
      match[1].toLowerCase()
    )
    const inputType = node.getAttribute('type')?.toLowerCase() ?? ''
    return !excludedTypes.includes(inputType)
  })
}

function createFillEvalNode(options: {
  tagName: string
  role?: string
  ariaControls?: string
  descendant?: FillEvalNode | null
  descendants?: FillEvalNode[]
  type?: string
}) {
  const events: TestEvent[] = []
  let value = ''
  const proto = {
    get value() {
      return value
    },
    set value(next: string) {
      value = next
    }
  }
  const node = Object.create(proto) as FillEvalNode

  node.tagName = options.tagName
  node.getAttribute = (name: string) => {
    if (name === 'role') {
      return options.role ?? null
    }
    if (name === 'aria-controls') {
      return options.ariaControls ?? null
    }
    if (name === 'type') {
      return options.type ?? null
    }
    return null
  }
  node.matches = vi.fn((selector: string) => matchesFillEvalSelector(node, selector))
  const descendants = options.descendants ?? (options.descendant ? [options.descendant] : [])
  node.querySelector = vi.fn(
    (selector: string) => descendants.find((descendant) => descendant.matches(selector)) ?? null
  )
  node.dispatchEvent = vi.fn((event: TestEvent) => {
    events.push(event)
    return true
  })

  return {
    node,
    events,
    get value() {
      return value
    }
  }
}

function runFillEvalExpressions(
  expressions: string[],
  document: { activeElement: unknown; getElementById: (id: string) => unknown },
  windowObject: Record<string, unknown> = {}
): void {
  for (const expression of expressions) {
    new Function('document', 'Event', 'window', `return (${expression})`)(
      document,
      TestEvent,
      windowObject
    )
  }
}

function createContentEditableEvalEnvironment(initialText: string) {
  const editor = {
    tagName: 'DIV',
    isContentEditable: true,
    textContent: initialText,
    matches: vi.fn(() => false),
    getAttribute: vi.fn((name: string) => (name === 'contenteditable' ? 'true' : null)),
    dispatchEvent: vi.fn()
  }
  let selected = false
  const selection = {
    selectAllChildren: vi.fn(() => {
      selected = true
    })
  }
  const execCommand = vi.fn((command: string, _showUi: boolean, value: string) => {
    // Chromium treats an empty insertText as a successful no-op; deletion is
    // required to clear a selected contenteditable through the input pipeline.
    if (command === 'delete') {
      if (!selected) {
        return false
      }
      editor.textContent = ''
    } else if (value.length > 0) {
      editor.textContent = selected ? value : editor.textContent + value
    }
    selected = false
    return true
  })
  return {
    editor,
    execCommand,
    document: {
      activeElement: editor,
      body: {},
      getElementById: () => null,
      execCommand
    },
    windowObject: { getSelection: () => selection }
  }
}

const CDP_DISCOVERY_FAILURE =
  'Auto-launch failed: All CDP discovery methods failed: connect ECONNREFUSED 127.0.0.1:9222; WebSocket connect failed'

describe('AgentBrowserBridge', () => {
  let bridge: AgentBrowserBridge

  beforeEach(() => {
    vi.clearAllMocks()
    stdinWrites.length = 0
    CdpWsProxyMock.instances.length = 0
    existsSyncMock.mockReturnValue(false)
    readFileSyncMock.mockReturnValue(Buffer.from(''))
    const wc = mockWebContents(100)
    webContentsFromIdMock.mockReturnValue(wc)
    bridge = new AgentBrowserBridge(mockBrowserManager())
    bridge.setActiveTab(100)
  })

  // ── Session naming ──

  it('uses browserPageId as session name', async () => {
    succeedWith({ snapshot: '...' })
    await bridge.snapshot()

    const args = execFileMock.mock.calls[0][1] as string[]
    expect(args).toContain('--session')
    expect(args[args.indexOf('--session') + 1]).toBe('orca-tab-tab-1')
  })

  // ── Embedded CDP ownership ──

  it('passes --cdp on every helper command family so a restarted daemon cannot launch Chrome', async () => {
    succeedWith({ snapshot: '...' })
    await bridge.snapshot()

    // Why: calls[0] is stale-session 'close'; find the snapshot call
    const snapshotCall = execFileMock.mock.calls.find((c: unknown[]) =>
      (c[1] as string[]).includes('snapshot')
    )
    expect(snapshotCall![1]).toContain('--cdp')
    const cdpIdx = (snapshotCall![1] as string[]).indexOf('--cdp')
    expect((snapshotCall![1] as string[])[cdpIdx + 1]).toBe('9222')

    await bridge.click('@e1')
    await bridge.mouseMove(10, 20)
    await bridge.setOffline('on')
    await bridge.consoleLog()
    await bridge.exec('get title')

    for (const command of ['click', 'mouse', 'set', 'console', 'get']) {
      const call = execFileMock.mock.calls.find((candidate: unknown[]) =>
        (candidate[1] as string[]).includes(command)
      )
      expect(call).toBeDefined()
      const args = call![1] as string[]
      expect(args).toContain('--cdp')
      expect(args[args.indexOf('--cdp') + 1]).toBe('9222')
    }
  })

  it('fails closed when stale agent-browser session ownership cannot be reset', async () => {
    vi.useFakeTimers()
    try {
      const closeKill = vi.fn()
      execFileMock.mockImplementation(
        (_bin: string, args: string[], _opts: unknown, cb: Function) => {
          if (args.includes('close')) {
            return { kill: closeKill }
          }
          if (args.includes('snapshot')) {
            cb(null, JSON.stringify({ success: true, data: { snapshot: 'ready' } }), '')
            return { kill: vi.fn() }
          }
          throw new Error(`unexpected agent-browser args ${args.join(' ')}`)
        }
      )

      const promise = bridge.snapshot()
      const rejection = expect(promise).rejects.toMatchObject({
        code: 'browser_owner_unavailable',
        message:
          'Could not reset stale helper session orca-tab-tab-1; retry after agent-browser exits'
      })

      await vi.advanceTimersByTimeAsync(3_000)

      await rejection
      expect(closeKill).toHaveBeenCalled()
      expect(execFileMock.mock.calls.some((call) => call[1].includes('snapshot'))).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  // ── --json always appended ──

  it('always appends --json to commands', async () => {
    succeedWith({ snapshot: '...' })
    await bridge.snapshot()

    const snapshotCall = execFileMock.mock.calls.find((c: unknown[]) =>
      (c[1] as string[]).includes('snapshot')
    )
    expect((snapshotCall![1] as string[]).at(-1)).toBe('--json')
  })

  // ── Output translation ──

  it('translates success response to result', async () => {
    succeedWith({ snapshot: 'tree output' })
    const result = await bridge.snapshot()
    expect(result).toEqual({ browserPageId: 'tab-1', snapshot: 'tree output' })
  })

  it('routes snapshot to an explicit browser page id without changing the active tab', async () => {
    const tabs = new Map([
      ['tab-a', 1],
      ['tab-b', 2]
    ])
    const wc1 = mockWebContents(1, 'https://a.com', 'A')
    const wc2 = mockWebContents(2, 'https://b.com', 'B')
    webContentsFromIdMock.mockImplementation((id: number) => (id === 1 ? wc1 : wc2))

    const b = new AgentBrowserBridge(mockBrowserManager(tabs))
    b.setActiveTab(1)

    succeedWith({ snapshot: 'tree output' })
    const result = await b.snapshot(undefined, 'tab-b')

    const snapshotCall = execFileMock.mock.calls.find((c: unknown[]) =>
      (c[1] as string[]).includes('snapshot')
    )
    expect(snapshotCall).toBeTruthy()
    expect(snapshotCall![1]).toContain('--session')
    expect(
      (snapshotCall![1] as string[])[(snapshotCall![1] as string[]).indexOf('--session') + 1]
    ).toBe('orca-tab-tab-b')
    expect(result).toEqual({ browserPageId: 'tab-b', snapshot: 'tree output' })
    expect(b.getActiveWebContentsId()).toBe(1)
  })

  it('translates error response to BrowserError', async () => {
    failWith('Element not found')
    await expect(bridge.click('@e1')).rejects.toThrow('Element not found')
  })

  it('keeps CDP discovery failures generic while the tab session is still live', async () => {
    failWith(CDP_DISCOVERY_FAILURE)
    await expect(bridge.snapshot()).rejects.toMatchObject({
      code: 'browser_error',
      message: CDP_DISCOVERY_FAILURE
    })
  })

  it('maps in-flight CDP discovery failures to tab not found after the session disappears', async () => {
    let releaseSnapshot: (() => void) | null = null
    const activeChild = { kill: vi.fn() }
    execFileMock.mockImplementation(
      (_bin: string, args: string[], _opts: unknown, cb: Function) => {
        if (args.includes('snapshot')) {
          releaseSnapshot = () => {
            cb(null, JSON.stringify({ success: false, error: CDP_DISCOVERY_FAILURE }), '')
          }
          return activeChild
        }
        cb(null, JSON.stringify({ success: true, data: null }), '')
        return { kill: vi.fn() }
      }
    )

    const snapshotPromise = bridge.snapshot()

    await vi.waitFor(() => {
      expect(releaseSnapshot).not.toBeNull()
    })
    // Why: this reproduces the teardown race where the tab close path has
    // already removed the bridge session before agent-browser reports that
    // its CDP proxy disappeared.
    ;(bridge as unknown as { sessions: Map<string, unknown> }).sessions.delete('orca-tab-tab-1')
    releaseSnapshot!()

    await expect(snapshotPromise).rejects.toMatchObject({
      code: 'browser_tab_not_found',
      message: 'Browser page tab-1 is no longer available'
    })
  })

  it('maps target disappearance during session creation to tab not found', async () => {
    const wc = mockWebContents(100)
    webContentsFromIdMock.mockImplementationOnce(() => wc).mockImplementationOnce(() => null)

    await expect(bridge.snapshot(undefined, 'tab-1')).rejects.toMatchObject({
      code: 'browser_tab_not_found',
      message: 'Browser page tab-1 is no longer available'
    })
  })

  it('handles malformed JSON from agent-browser', async () => {
    execFileMock.mockImplementation(
      (_bin: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, 'not json at all', '')
      }
    )
    await expect(bridge.snapshot()).rejects.toThrow()
  })

  // ── exec passthrough ──

  it('strips --cdp and --session from exec commands', async () => {
    succeedWith({ output: 'ok' })
    await bridge.exec(
      'dblclick @e3 --cdp ws://evil --session hijack --cdp=ws://evil-equals --session=hijack-equals'
    )

    // Why: find the actual exec call (contains 'dblclick'), not the stale-session close
    const execCall = execFileMock.mock.calls.find((c: unknown[]) =>
      (c[1] as string[]).includes('dblclick')
    )
    const args = execCall![1] as string[]
    // The bridge's own --session and --cdp (for session init) are expected.
    // Verify the user-injected ones were stripped, including --flag=value forms.
    expect(args.join(' ')).not.toContain('ws://evil')
    expect(args.join(' ')).not.toContain('ws://evil-equals')
    expect(args.join(' ')).not.toContain('hijack')
    expect(args.join(' ')).not.toContain('hijack-equals')
    expect(args).toContain('dblclick')
    expect(args).toContain('@e3')
  })

  // ── Worktree filtering ──

  describe('worktree filtering', () => {
    it('returns all tabs when no worktreeId', () => {
      const tabs = new Map([
        ['tab-a', 1],
        ['tab-b', 2]
      ])
      const b = new AgentBrowserBridge(mockBrowserManager(tabs))
      const result = b.tabList()
      expect(result.tabs).toHaveLength(2)
    })

    it('returns only matching worktree tabs', () => {
      const tabs = new Map([
        ['tab-a', 1],
        ['tab-b', 2]
      ])
      const worktrees = new Map([
        ['tab-a', 'wt-1'],
        ['tab-b', 'wt-2']
      ])
      const wc1 = mockWebContents(1, 'https://a.com', 'A')
      const wc2 = mockWebContents(2, 'https://b.com', 'B')
      webContentsFromIdMock.mockImplementation((id: number) => (id === 1 ? wc1 : wc2))

      const b = new AgentBrowserBridge(mockBrowserManager(tabs, worktrees))
      const result = b.tabList('wt-1')
      expect(result.tabs).toHaveLength(1)
      expect(result.tabs[0].browserPageId).toBe('tab-a')
      expect(result.tabs[0].url).toBe('https://a.com')
    })

    it('surfaces the browser-manager load error on each listed tab', () => {
      const tabs = new Map([['tab-a', 1]])
      const wc1 = mockWebContents(1, 'chrome-error://chromewebdata/', '')
      webContentsFromIdMock.mockImplementation((id: number) => (id === 1 ? wc1 : null))
      const loadError = {
        code: -202,
        description: 'ERR_CERT_AUTHORITY_INVALID',
        validatedUrl: 'https://localhost:3443/'
      }
      const certificateFailure = {
        challengeId: 'challenge-1',
        browserPageId: 'tab-a',
        errorCode: -202,
        error: 'ERR_CERT_AUTHORITY_INVALID',
        origin: 'https://localhost:3443',
        displayHost: 'localhost:3443',
        canProceed: true,
        observedAt: 123
      }
      const b = new AgentBrowserBridge(
        mockBrowserManager(tabs, new Map(), {
          getBrowserPageLoadError: vi.fn((tabId: string) => (tabId === 'tab-a' ? loadError : null)),
          getBrowserPageCertificateFailure: vi.fn((tabId: string) =>
            tabId === 'tab-a' ? certificateFailure : null
          )
        })
      )

      // Why: an agent driving the browser must see the structured cert failure,
      // not just chrome-error:// from getURL().
      expect(b.tabList().tabs[0]).toMatchObject({
        url: 'https://localhost:3443/',
        loadError,
        certificateFailure
      })
    })

    it('does not mutate active-tab routing when tab-list infers the first live tab', () => {
      const tabs = new Map([
        ['tab-a', 1],
        ['tab-b', 2]
      ])
      const wc1 = mockWebContents(1, 'https://a.com', 'A')
      const wc2 = mockWebContents(2, 'https://b.com', 'B')
      webContentsFromIdMock.mockImplementation((id: number) => (id === 1 ? wc1 : wc2))

      const b = new AgentBrowserBridge(mockBrowserManager(tabs))

      const result = b.tabList()
      expect(result.tabs).toMatchObject([
        { browserPageId: 'tab-a', active: true },
        { browserPageId: 'tab-b', active: false }
      ])
      expect(b.getActiveWebContentsId()).toBeNull()
    })

    it('unregisters stale tab-list entries when their WebContents is gone', () => {
      const tabs = new Map([
        ['tab-a', 1],
        ['tab-b', 2]
      ])
      const wc2 = mockWebContents(2, 'https://b.com', 'B')
      webContentsFromIdMock.mockImplementation((id: number) => (id === 2 ? wc2 : null))
      const unregisterGuest = vi.fn()

      const b = new AgentBrowserBridge(mockBrowserManager(tabs, new Map(), { unregisterGuest }))

      expect(b.tabList().tabs).toMatchObject([{ browserPageId: 'tab-b', active: true }])
      expect(unregisterGuest).toHaveBeenCalledWith('tab-a')
    })
  })

  // ── Tab switch ──

  it('throws on out-of-range tab index', async () => {
    await expect(bridge.tabSwitch(99)).rejects.toThrow('Tab index 99 out of range')
  })

  // ── No tab error ──

  it('throws browser_no_tab when no tabs registered', async () => {
    const b = new AgentBrowserBridge(mockBrowserManager(new Map()))
    await expect(b.snapshot()).rejects.toThrow('No browser tab open')
  })

  it('uses the runtime mobile tap path when a nearby DOM target is handled', async () => {
    const wc = mockWebContents(100)
    wc.debugger.sendCommand.mockImplementation(async (method: string) => {
      if (method === 'Runtime.evaluate') {
        return { result: { value: { x: 12, y: 34, adjusted: true, handled: true } } }
      }
      return {}
    })
    webContentsFromIdMock.mockReturnValue(wc)

    const result = await bridge.mouseClick(10, 20, 'left', undefined, 'tab-1', 18)

    expect(result).toEqual({
      clicked: { x: 12, y: 34, button: 'left', adjusted: true, handled: true }
    })
    expect(wc.debugger.sendCommand).toHaveBeenCalledWith(
      'Runtime.evaluate',
      expect.objectContaining({ returnByValue: true, silent: true })
    )
    expect(
      wc.debugger.sendCommand.mock.calls.some((call) => call[0] === 'Input.dispatchMouseEvent')
    ).toBe(false)
  })

  it('falls back to CDP mouse events when runtime does not handle a mobile tap', async () => {
    const wc = mockWebContents(100)
    wc.debugger.sendCommand.mockImplementation(async (method: string) => {
      if (method === 'Runtime.evaluate') {
        return { result: { value: { x: 10, y: 20, adjusted: false, handled: false } } }
      }
      return {}
    })
    webContentsFromIdMock.mockReturnValue(wc)

    await expect(bridge.mouseClick(10, 20, 'left', undefined, 'tab-1', 18)).resolves.toEqual({
      clicked: { x: 10, y: 20, button: 'left', adjusted: false, handled: false }
    })

    const mouseCalls = wc.debugger.sendCommand.mock.calls.filter(
      (call) => call[0] === 'Input.dispatchMouseEvent'
    )
    expect(mouseCalls).toHaveLength(2)
    expect(mouseCalls[0]?.[1]).toMatchObject({ type: 'mousePressed', x: 10, y: 20 })
    expect(mouseCalls[1]?.[1]).toMatchObject({ type: 'mouseReleased', x: 10, y: 20 })
  })

  it('passes mobile click modifiers through to CDP mouse events', async () => {
    const wc = mockWebContents(100)
    wc.debugger.sendCommand.mockImplementation(async (method: string) => {
      if (method === 'Runtime.evaluate') {
        return { result: { value: { x: 10, y: 20, adjusted: false, handled: false } } }
      }
      return {}
    })
    webContentsFromIdMock.mockReturnValue(wc)

    await bridge.mouseClick(10, 20, 'left', undefined, 'tab-1', 18, ['cmd', 'shift'])

    const mouseCalls = wc.debugger.sendCommand.mock.calls.filter(
      (call) => call[0] === 'Input.dispatchMouseEvent'
    )
    expect(mouseCalls[0]?.[1]).toMatchObject({ type: 'mousePressed', modifiers: 12 })
    expect(mouseCalls[1]?.[1]).toMatchObject({ type: 'mouseReleased', modifiers: 12 })
  })

  it('keeps adjusted mobile tap coordinates but uses CDP for modifier clicks', async () => {
    const wc = mockWebContents(100)
    wc.debugger.sendCommand.mockImplementation(async (method: string) => {
      if (method === 'Runtime.evaluate') {
        return { result: { value: { x: 12, y: 34, adjusted: true, handled: false } } }
      }
      return {}
    })
    webContentsFromIdMock.mockReturnValue(wc)

    await expect(
      bridge.mouseClick(10, 20, 'left', undefined, 'tab-1', 18, ['cmd'])
    ).resolves.toEqual({
      clicked: { x: 12, y: 34, button: 'left', adjusted: true, handled: false }
    })

    const evaluateCall = wc.debugger.sendCommand.mock.calls.find(
      (call) => call[0] === 'Runtime.evaluate'
    )
    expect((evaluateCall?.[1] as { expression?: string } | undefined)?.expression).toContain(
      'const allowDomActivation = false'
    )
    const mouseCalls = wc.debugger.sendCommand.mock.calls.filter(
      (call) => call[0] === 'Input.dispatchMouseEvent'
    )
    expect(mouseCalls).toHaveLength(2)
    expect(mouseCalls[0]?.[1]).toMatchObject({ type: 'mousePressed', x: 12, y: 34, modifiers: 4 })
    expect(mouseCalls[1]?.[1]).toMatchObject({ type: 'mouseReleased', x: 12, y: 34, modifiers: 4 })
  })

  it('drops empty command queues after direct CDP commands finish', async () => {
    const wc = mockWebContents(100)
    wc.debugger.sendCommand.mockResolvedValue({})
    webContentsFromIdMock.mockReturnValue(wc)

    await bridge.mouseClick(10, 20, 'right', undefined, 'tab-1')

    expect(
      (bridge as unknown as { commandQueues: Map<string, unknown[]> }).commandQueues.size
    ).toBe(0)
    expect((bridge as unknown as { processingQueues: Set<string> }).processingQueues.size).toBe(0)
  })

  // ── Command queue serialization ──

  it('serializes concurrent commands per session', async () => {
    const commandCalls: string[][] = []

    execFileMock.mockImplementation(
      (_bin: string, args: string[], _opts: unknown, cb: Function) => {
        commandCalls.push(args)
        cb(null, JSON.stringify({ success: true, data: { ok: true } }), '')
      }
    )

    const [r1, r2] = await Promise.all([bridge.snapshot(), bridge.click('@e1')])
    expect(r1).toEqual({ browserPageId: 'tab-1', ok: true })
    expect(r2).toEqual({ ok: true })
    // Why: close runs first (stale session cleanup), then commands execute sequentially
    const snapshotIdx = commandCalls.findIndex((a) => a.includes('snapshot'))
    const clickIdx = commandCalls.findIndex((a) => a.includes('click'))
    expect(snapshotIdx).toBeLessThan(clickIdx)
  })

  it('acquires an automation visibility lease while running snapshot commands', async () => {
    const lifecycleEvents: string[] = []
    const restore = vi.fn(() => {
      lifecycleEvents.push('restore-100')
    })
    const acquireAutomationVisibility = vi.fn(async (webContentsId: number) => {
      lifecycleEvents.push(`acquire-${webContentsId}`)
      return restore
    })

    const b = new AgentBrowserBridge(
      mockBrowserManager(undefined, undefined, {
        acquireAutomationVisibility
      })
    )
    b.setActiveTab(100)

    let releaseSnapshot: (() => void) | null = null
    execFileMock.mockImplementation(
      (_bin: string, args: string[], _opts: unknown, cb: Function) => {
        if (args.includes('close')) {
          cb(null, JSON.stringify({ success: true, data: null }), '')
          return
        }
        if (args.includes('snapshot')) {
          lifecycleEvents.push('command-snapshot')
          releaseSnapshot = () => {
            cb(null, JSON.stringify({ success: true, data: { snapshot: 'tree' } }), '')
          }
          return
        }
        cb(null, JSON.stringify({ success: true, data: { ok: true } }), '')
      }
    )

    const snapshot = b.snapshot()

    await vi.waitFor(() => {
      expect(releaseSnapshot).not.toBeNull()
    })
    expect(lifecycleEvents).toEqual(['acquire-100', 'command-snapshot'])
    expect(restore).not.toHaveBeenCalled()

    releaseSnapshot!()

    await expect(snapshot).resolves.toEqual({ browserPageId: 'tab-1', snapshot: 'tree' })
    expect(lifecycleEvents).toEqual(['acquire-100', 'command-snapshot', 'restore-100'])
  })

  it('re-resolves the page after automation visibility re-registers the webview', async () => {
    const tabs = new Map([['tab-1', 100]])
    const wc100 = mockWebContents(100)
    const wc200 = mockWebContents(200, 'https://example.com/reloaded', 'Reloaded')
    webContentsFromIdMock.mockImplementation((id: number) => {
      if (id === 100) {
        return wc100
      }
      if (id === 200) {
        return wc200
      }
      return null
    })

    const acquireAutomationVisibility = vi.fn(async () => {
      tabs.set('tab-1', 200)
      return vi.fn()
    })
    const b = new AgentBrowserBridge(
      mockBrowserManager(tabs, undefined, {
        acquireAutomationVisibility
      })
    )
    b.setActiveTab(100)

    succeedWith({ snapshot: 'tree' })
    await expect(b.snapshot()).resolves.toEqual({ browserPageId: 'tab-1', snapshot: 'tree' })

    expect(acquireAutomationVisibility).toHaveBeenCalledWith(100)
    const createdProxyIds = CdpWsProxyMock.instances.map(
      (instance) => (instance as { _wc?: { id?: number } })._wc?.id
    )
    expect(createdProxyIds).toEqual([100, 200])
  })

  it('preserves intercept routes when automation visibility re-registers the webview', async () => {
    const tabs = new Map([['tab-1', 100]])
    const wc100 = mockWebContents(100)
    const wc200 = mockWebContents(200, 'https://example.com/reloaded', 'Reloaded')
    webContentsFromIdMock.mockImplementation((id: number) => {
      if (id === 100) {
        return wc100
      }
      if (id === 200) {
        return wc200
      }
      return null
    })

    let reregisterOnVisibility = false
    const acquireAutomationVisibility = vi.fn(async () => {
      if (reregisterOnVisibility) {
        tabs.set('tab-1', 200)
      }
      return vi.fn()
    })
    const b = new AgentBrowserBridge(
      mockBrowserManager(tabs, undefined, {
        acquireAutomationVisibility
      })
    )
    b.setActiveTab(100)

    const commandCalls: string[][] = []
    execFileMock.mockImplementation(
      (_bin: string, args: string[], _opts: unknown, cb: Function) => {
        commandCalls.push(args)
        cb(null, JSON.stringify({ success: true, data: { ok: true } }), '')
      }
    )

    await b.interceptEnable(['https://old.example/**'])
    reregisterOnVisibility = true
    await expect(b.snapshot()).resolves.toEqual({ browserPageId: 'tab-1', ok: true })

    const routeCalls = commandCalls.filter(
      (args) => args.includes('network') && args.includes('route')
    )
    expect(routeCalls).toHaveLength(2)
    expect(routeCalls.at(-1)).toContain('https://old.example/**')
    expect(routeCalls.at(-1)).toContain('--cdp')
    expect(routeCalls.at(-1)).toContain('9222')
  })

  it('clears stale sessions after direct CDP visibility re-registration', async () => {
    const tabs = new Map([['tab-1', 100]])
    const wc100 = mockWebContents(100)
    const wc200 = mockWebContents(200, 'https://example.com/reloaded', 'Reloaded')
    wc200.debugger.sendCommand.mockResolvedValue({})
    webContentsFromIdMock.mockImplementation((id: number) => {
      if (id === 100) {
        return wc100
      }
      if (id === 200) {
        return wc200
      }
      return null
    })

    let reregisterOnVisibility = false
    const acquireAutomationVisibility = vi.fn(async () => {
      if (reregisterOnVisibility) {
        tabs.set('tab-1', 200)
      }
      return vi.fn()
    })
    const b = new AgentBrowserBridge(
      mockBrowserManager(tabs, undefined, {
        acquireAutomationVisibility
      })
    )
    b.setActiveTab(100)

    succeedWith({ snapshot: 'before' })
    await b.snapshot()

    reregisterOnVisibility = true
    await expect(b.mouseClick(10, 20, 'right', undefined, 'tab-1')).resolves.toEqual({
      clicked: { x: 10, y: 20, button: 'right', adjusted: false, handled: false }
    })

    succeedWith({ snapshot: 'after' })
    await expect(b.snapshot()).resolves.toEqual({ browserPageId: 'tab-1', snapshot: 'after' })

    const createdProxyIds = CdpWsProxyMock.instances.map(
      (instance) => (instance as { _wc?: { id?: number } })._wc?.id
    )
    expect(createdProxyIds).toEqual([100, 200])
  })

  it('clears reload fallback timer after the load event settles', async () => {
    vi.useFakeTimers()
    try {
      succeedWith(null)
      const wc = {
        ...mockWebContents(100, 'https://reloaded.example', 'Reloaded'),
        reload: vi.fn(),
        on: vi.fn(),
        removeListener: vi.fn()
      }
      webContentsFromIdMock.mockReturnValue(wc)

      const result = bridge.reload()

      await vi.waitFor(() => {
        expect(wc.on).toHaveBeenCalledWith('did-finish-load', expect.any(Function))
      })

      const finishListener = wc.on.mock.calls.find(
        ([event]) => event === 'did-finish-load'
      )?.[1] as (() => void) | undefined
      const failListener = wc.on.mock.calls.find(([event]) => event === 'did-fail-load')?.[1] as
        | (() => void)
        | undefined
      expect(finishListener).toBeDefined()
      expect(failListener).toBeDefined()
      expect(vi.getTimerCount()).toBe(1)

      finishListener!()

      await expect(result).resolves.toEqual({
        url: 'https://reloaded.example',
        title: 'Reloaded'
      })
      expect(wc.removeListener).toHaveBeenCalledWith('did-finish-load', finishListener)
      expect(wc.removeListener).toHaveBeenCalledWith('did-fail-load', failListener)
      expect(vi.getTimerCount()).toBe(0)

      await vi.advanceTimersByTimeAsync(10_000)
      expect(wc.removeListener).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('serializes screenshot visibility prep across sessions', async () => {
    vi.useFakeTimers()
    try {
      const tabs = new Map([
        ['tab-1', 1],
        ['tab-2', 2]
      ])
      const worktrees = new Map([
        ['tab-1', 'wt-1'],
        ['tab-2', 'wt-2']
      ])
      const lifecycleEvents: string[] = []
      const acquireAutomationVisibilityMock = vi.fn(async (webContentsId: number) => {
        lifecycleEvents.push(`acquire-${webContentsId}`)
        return () => {
          lifecycleEvents.push(`restore-${webContentsId}`)
        }
      })
      const wc1 = mockWebContents(1)
      const wc2 = mockWebContents(2)
      webContentsFromIdMock.mockImplementation((id: number) =>
        id === 1 ? wc1 : id === 2 ? wc2 : null
      )
      existsSyncMock.mockReturnValue(true)
      const screenshotBytes = Buffer.from('serialized-screenshot')
      readFileSyncMock.mockReturnValue(screenshotBytes)

      const b = new AgentBrowserBridge(
        mockBrowserManager(tabs, worktrees, {
          acquireAutomationVisibility: acquireAutomationVisibilityMock
        })
      )
      b.setActiveTab(1, 'wt-1')
      b.setActiveTab(2, 'wt-2')

      let releaseFirstScreenshot: (() => void) | null = null
      execFileMock.mockImplementation(
        (_bin: string, args: string[], _opts: unknown, cb: Function) => {
          if (args.includes('close')) {
            cb(null, JSON.stringify({ success: true, data: null }), '')
            return
          }
          if (args.includes('screenshot')) {
            const sessionName = args[args.indexOf('--session') + 1]
            lifecycleEvents.push(`command-${sessionName}`)
            if (sessionName === 'orca-tab-tab-1' && !releaseFirstScreenshot) {
              releaseFirstScreenshot = () => {
                cb(null, JSON.stringify({ success: true, data: { path: '/tmp/tab-1.png' } }), '')
              }
              return
            }
            cb(
              null,
              JSON.stringify({ success: true, data: { path: `/tmp/${sessionName}.png` } }),
              ''
            )
            return
          }
          cb(null, JSON.stringify({ success: true, data: { ok: true } }), '')
        }
      )

      const first = b.screenshot('png', 'wt-1')
      const second = b.screenshot('png', 'wt-2')

      await Promise.resolve()
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(300)

      expect(lifecycleEvents).toContain('acquire-1')
      expect(lifecycleEvents).toContain('command-orca-tab-tab-1')
      expect(lifecycleEvents).not.toContain('acquire-2')

      expect(releaseFirstScreenshot).not.toBeNull()
      releaseFirstScreenshot!()
      await expect(first).resolves.toEqual({
        data: screenshotBytes.toString('base64'),
        format: 'png'
      })

      await Promise.resolve()
      await Promise.resolve()

      expect(lifecycleEvents.indexOf('restore-1')).toBeLessThan(
        lifecycleEvents.indexOf('acquire-2')
      )

      await vi.advanceTimersByTimeAsync(300)
      await expect(second).resolves.toEqual({
        data: screenshotBytes.toString('base64'),
        format: 'png'
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('captures full-page screenshots directly through CDP using CSS layout bounds', async () => {
    vi.useFakeTimers()
    try {
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
        (_bin: string, _args: string[], _opts: unknown, cb: Function) => {
          cb(null, JSON.stringify({ success: true, data: null }), '')
        }
      )

      const screenshotPromise = bridge.fullPageScreenshot('png')
      await vi.advanceTimersByTimeAsync(500)

      await expect(screenshotPromise).resolves.toEqual({
        data: 'full-cdp-shot',
        format: 'png'
      })

      expect(wc.debugger.sendCommand).toHaveBeenNthCalledWith(1, 'Page.getLayoutMetrics', {})
      expect(wc.debugger.sendCommand).toHaveBeenNthCalledWith(2, 'Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: 601, height: 901, scale: 1 }
      })
      const screenshotCall = execFileMock.mock.calls.find((call: unknown[]) =>
        (call[1] as string[]).includes('screenshot')
      )
      expect(screenshotCall).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  // ── Timeout escalation ──

  it('destroys session after 3 consecutive timeouts', async () => {
    const killedError = Object.assign(new Error('timeout'), { killed: true })

    execFileMock.mockImplementation(
      (_bin: string, args: string[], _opts: unknown, cb: Function) => {
        if (args.includes('close')) {
          cb(null, JSON.stringify({ success: true, data: null }), '')
          return
        }
        cb(killedError, '', '')
      }
    )

    for (let i = 0; i < 3; i++) {
      await expect(bridge.snapshot()).rejects.toThrow('timed out')
    }

    // Session is destroyed — next command should re-create it (new --cdp flag)
    succeedWith({ snapshot: 'fresh' })
    await bridge.snapshot()

    const lastArgs = execFileMock.mock.calls.at(-1)![1] as string[]
    expect(lastArgs).toContain('--cdp')
  })

  it('waits for pending session destruction before recreating the same session', async () => {
    succeedWith({ snapshot: 'initial' })
    await bridge.snapshot()

    execFileMock.mockClear()

    const commandCalls: string[][] = []
    let releaseDestroyClose: (() => void) | null = null
    execFileMock.mockImplementation(
      (_bin: string, args: string[], _opts: unknown, cb: Function) => {
        commandCalls.push(args)
        if (args.includes('close')) {
          if (!releaseDestroyClose) {
            releaseDestroyClose = () => {
              cb(null, JSON.stringify({ success: true, data: null }), '')
            }
            return
          }
          cb(null, JSON.stringify({ success: true, data: null }), '')
          return
        }
        if (args.includes('snapshot')) {
          cb(null, JSON.stringify({ success: true, data: { snapshot: 'after-destroy' } }), '')
          return
        }
        cb(null, JSON.stringify({ success: true, data: { ok: true } }), '')
      }
    )

    const destroyPromise = (
      bridge as unknown as { destroySession: (name: string) => Promise<void> }
    ).destroySession('orca-tab-tab-1')
    const nextSnapshot = bridge.snapshot()

    await Promise.resolve()
    await Promise.resolve()

    expect(commandCalls.filter((args) => args.includes('close'))).toHaveLength(1)
    expect(commandCalls.some((args) => args.includes('snapshot'))).toBe(false)
    expect(releaseDestroyClose).not.toBeNull()

    releaseDestroyClose!()
    await destroyPromise
    await expect(nextSnapshot).resolves.toEqual({
      browserPageId: 'tab-1',
      snapshot: 'after-destroy'
    })
    expect(commandCalls.filter((args) => args.includes('close'))).toHaveLength(2)
  })

  it('tears down a session that finishes creating after destruction starts', async () => {
    const commandCalls: string[][] = []
    let releaseStaleClose: (() => void) | null = null
    execFileMock.mockImplementation(
      (_bin: string, args: string[], _opts: unknown, cb: Function) => {
        commandCalls.push(args)
        if (args.includes('close') && !releaseStaleClose) {
          releaseStaleClose = () => {
            cb(null, JSON.stringify({ success: true, data: null }), '')
          }
          return { kill: vi.fn() }
        }
        cb(null, JSON.stringify({ success: true, data: null }), '')
        return { kill: vi.fn() }
      }
    )

    const ensurePromise = (
      bridge as unknown as {
        ensureSession: (
          sessionName: string,
          browserPageId: string,
          webContentsId: number
        ) => Promise<void>
      }
    ).ensureSession('orca-tab-tab-1', 'tab-1', 100)

    await vi.waitFor(() => {
      expect(releaseStaleClose).not.toBeNull()
    })
    expect(CdpWsProxyMock.instances).toHaveLength(0)

    const destroyPromise = (
      bridge as unknown as { destroySession: (name: string) => Promise<void> }
    ).destroySession('orca-tab-tab-1')

    releaseStaleClose!()
    await ensurePromise
    await destroyPromise

    const sessions = (bridge as unknown as { sessions: Map<string, unknown> }).sessions
    const proxy = CdpWsProxyMock.instances[0] as { stop: ReturnType<typeof vi.fn> }
    expect(commandCalls.filter((args) => args.includes('close'))).toHaveLength(2)
    expect(sessions.size).toBe(0)
    expect(proxy.stop).toHaveBeenCalledTimes(1)
  })

  it('cancels the command already running when a session is destroyed', async () => {
    succeedWith({ snapshot: 'initial' })
    await bridge.snapshot()

    execFileMock.mockClear()

    const killedError = Object.assign(new Error('killed'), { killed: true })
    let resolveRunningCommand: (() => void) | null = null
    const activeChild = {
      kill: vi.fn(() => {
        resolveRunningCommand?.()
      })
    }

    execFileMock.mockImplementation(
      (_bin: string, args: string[], _opts: unknown, cb: Function) => {
        if (args.includes('snapshot')) {
          resolveRunningCommand = () => cb(killedError, '', '')
          return activeChild
        }
        if (args.includes('close')) {
          cb(null, JSON.stringify({ success: true, data: null }), '')
          return { kill: vi.fn() }
        }
        cb(null, JSON.stringify({ success: true, data: { ok: true } }), '')
        return { kill: vi.fn() }
      }
    )

    const runningSnapshot = bridge.snapshot()
    await vi.waitFor(() => {
      expect(resolveRunningCommand).not.toBeNull()
    })

    const destroyPromise = (
      bridge as unknown as { destroySession: (name: string) => Promise<void> }
    ).destroySession('orca-tab-tab-1')

    expect(activeChild.kill).toHaveBeenCalledTimes(1)
    await expect(runningSnapshot).rejects.toMatchObject({
      code: 'browser_tab_closed',
      message: 'Tab was closed while command was running'
    })
    await destroyPromise
  })

  // ── Process swap ──

  it('destroys session on process swap and re-inits with --cdp', async () => {
    const tabs = new Map([['tab-1', 100]])
    const mgr = mockBrowserManager(tabs)
    const b = new AgentBrowserBridge(mgr)
    b.setActiveTab(100)

    succeedWith({ snapshot: 'tree' })
    await b.snapshot()

    // Why: calls[0] is the stale-session 'close'; find the snapshot call with --cdp
    const firstSnapshotCall = execFileMock.mock.calls.find((c: unknown[]) =>
      (c[1] as string[]).includes('snapshot')
    )
    expect(firstSnapshotCall![1]).toContain('--cdp')

    // Simulate process swap: update tab mapping + notify bridge
    tabs.set('tab-1', 200)
    const newWc = mockWebContents(200)
    webContentsFromIdMock.mockReturnValue(newWc)
    succeedWith(null) // for the 'close' command in destroySession
    await b.onProcessSwap('tab-1', 200)

    // Next command should re-init with --cdp since session was destroyed
    succeedWith({ snapshot: 'new tree' })
    await b.snapshot()

    const snapshotCalls = execFileMock.mock.calls.filter((c: unknown[]) =>
      (c[1] as string[]).includes('snapshot')
    )
    expect(snapshotCalls.length).toBeGreaterThanOrEqual(2)
    const lastSnapshotArgs = snapshotCalls.at(-1)![1] as string[]
    // After process swap + session destroy, the new session must re-init with --cdp
    expect(lastSnapshotArgs).toContain('--cdp')
  })

  it('does not replay stale intercept routes after process swap when the first command disables routing', async () => {
    const tabs = new Map([['tab-1', 100]])
    const mgr = mockBrowserManager(tabs)
    const b = new AgentBrowserBridge(mgr)
    b.setActiveTab(100)

    succeedWith({ ok: true })
    await b.interceptEnable(['https://old.example/**'])

    tabs.set('tab-1', 200)
    webContentsFromIdMock.mockReturnValue(mockWebContents(200))
    succeedWith(null)
    await b.onProcessSwap('tab-1', 200)

    const commandCalls: string[][] = []
    execFileMock.mockImplementation(
      (_bin: string, args: string[], _opts: unknown, cb: Function) => {
        commandCalls.push(args)
        cb(null, JSON.stringify({ success: true, data: { ok: true } }), '')
      }
    )

    await b.interceptDisable()

    const routeCalls = commandCalls.filter(
      (args) => args.includes('network') && args.includes('route')
    )
    expect(routeCalls).toHaveLength(0)

    const unrouteCall = commandCalls.find(
      (args) => args.includes('network') && args.includes('unroute')
    )
    expect(unrouteCall).toBeDefined()
    expect(unrouteCall).toContain('--cdp')
  })

  it('does not replay stale intercept routes after process swap when the first command enables a new route', async () => {
    const tabs = new Map([['tab-1', 100]])
    const mgr = mockBrowserManager(tabs)
    const b = new AgentBrowserBridge(mgr)
    b.setActiveTab(100)

    succeedWith({ ok: true })
    await b.interceptEnable(['https://old.example/**'])

    tabs.set('tab-1', 200)
    webContentsFromIdMock.mockReturnValue(mockWebContents(200))
    succeedWith(null)
    await b.onProcessSwap('tab-1', 200)

    const commandCalls: string[][] = []
    execFileMock.mockImplementation(
      (_bin: string, args: string[], _opts: unknown, cb: Function) => {
        commandCalls.push(args)
        cb(null, JSON.stringify({ success: true, data: { ok: true } }), '')
      }
    )

    await b.interceptEnable(['https://new.example/**'])

    const routeCalls = commandCalls.filter(
      (args) => args.includes('network') && args.includes('route')
    )
    expect(routeCalls).toHaveLength(1)
    expect(routeCalls[0]).toContain('https://new.example/**')
    expect(routeCalls[0]).not.toContain('https://old.example/**')
    expect(routeCalls[0]).toContain('--cdp')
  })

  it('clears pending intercept restore state when a swapped tab closes before reuse', async () => {
    const tabs = new Map([['tab-1', 100]])
    const mgr = mockBrowserManager(tabs)
    const b = new AgentBrowserBridge(mgr)
    b.setActiveTab(100)

    succeedWith({ ok: true })
    await b.interceptEnable(['https://old.example/**'])

    tabs.set('tab-1', 200)
    webContentsFromIdMock.mockReturnValue(mockWebContents(200))
    succeedWith(null)
    await b.onProcessSwap('tab-1', 200)

    expect(
      (b as unknown as { pendingInterceptRestore: Map<string, string[]> }).pendingInterceptRestore
        .size
    ).toBe(1)

    await b.onTabClosed(200)

    expect(
      (b as unknown as { pendingInterceptRestore: Map<string, string[]> }).pendingInterceptRestore
        .size
    ).toBe(0)
  })

  // ── Tab close clears active ──

  it('clears activeWebContentsId on tab close', async () => {
    succeedWith({ snapshot: 'tree' })
    await bridge.snapshot()

    await bridge.onTabClosed(100)
    expect(bridge.getActiveWebContentsId()).toBeNull()
  })

  it('closes the named agent-browser session when a tab closes', async () => {
    succeedWith({ snapshot: 'tree' })
    await bridge.snapshot()

    execFileMock.mockClear()
    succeedWith(null)
    await bridge.onTabClosed(100)

    const closeCall = execFileMock.mock.calls.find((call: unknown[]) =>
      (call[1] as string[]).includes('close')
    )
    expect(closeCall).toBeTruthy()
    expect(closeCall![1]).toEqual(['--session', 'orca-tab-tab-1', 'close'])
  })

  it('repairs per-worktree active routing when the active tab closes', async () => {
    const tabs = new Map([
      ['tab-a', 1],
      ['tab-b', 2]
    ])
    const worktrees = new Map([
      ['tab-a', 'wt-1'],
      ['tab-b', 'wt-1']
    ])
    const wc2 = mockWebContents(2, 'https://b.com', 'B')
    webContentsFromIdMock.mockImplementation((id: number) => (id === 2 ? wc2 : null))

    const b = new AgentBrowserBridge(mockBrowserManager(tabs, worktrees))
    b.setActiveTab(1, 'wt-1')

    await b.onTabClosed(1)

    expect(b.getActiveWebContentsId()).toBe(2)
    expect(b.tabList('wt-1').tabs).toMatchObject([{ browserPageId: 'tab-b', active: true }])
  })

  it('repairs per-worktree active routing when an active tab swaps processes', async () => {
    const tabs = new Map([['tab-a', 200]])
    const worktrees = new Map([['tab-a', 'wt-1']])
    const wc = mockWebContents(200, 'https://a.com', 'A')
    webContentsFromIdMock.mockImplementation((id: number) => (id === 200 ? wc : null))

    const b = new AgentBrowserBridge(mockBrowserManager(tabs, worktrees))
    b.setActiveTab(100, 'wt-1')

    await b.onProcessSwap('tab-a', 200, 100)

    expect(b.getActiveWebContentsId()).toBe(200)
    expect(b.tabList('wt-1').tabs).toMatchObject([{ browserPageId: 'tab-a', active: true }])
  })

  // ── tabSwitch success ──

  it('switches active tab and returns switched index', async () => {
    const tabs = new Map([
      ['tab-a', 1],
      ['tab-b', 2]
    ])
    const wc1 = mockWebContents(1)
    const wc2 = mockWebContents(2)
    webContentsFromIdMock.mockImplementation((id: number) => (id === 1 ? wc1 : wc2))

    const b = new AgentBrowserBridge(mockBrowserManager(tabs))
    b.setActiveTab(1)

    const result = await b.tabSwitch(1)
    expect(result).toEqual({ switched: 1, browserPageId: 'tab-b' })
    expect(b.getActiveWebContentsId()).toBe(2)
  })

  it('switches tabs by explicit browser page id', async () => {
    const tabs = new Map([
      ['tab-a', 1],
      ['tab-b', 2]
    ])
    const wc1 = mockWebContents(1)
    const wc2 = mockWebContents(2)
    webContentsFromIdMock.mockImplementation((id: number) => (id === 1 ? wc1 : wc2))

    const b = new AgentBrowserBridge(mockBrowserManager(tabs))
    b.setActiveTab(1)

    const result = await b.tabSwitch(undefined, undefined, 'tab-b')
    expect(result).toEqual({ switched: 1, browserPageId: 'tab-b' })
    expect(b.getActiveWebContentsId()).toBe(2)
  })

  it('updates the owning worktree active tab when switching by browser page id', async () => {
    const tabs = new Map([
      ['tab-a', 1],
      ['tab-b', 2]
    ])
    const worktrees = new Map([
      ['tab-a', 'wt-1'],
      ['tab-b', 'wt-1']
    ])
    const wc1 = mockWebContents(1, 'https://a.com', 'A')
    const wc2 = mockWebContents(2, 'https://b.com', 'B')
    webContentsFromIdMock.mockImplementation((id: number) => (id === 1 ? wc1 : wc2))

    const b = new AgentBrowserBridge(mockBrowserManager(tabs, worktrees))
    b.setActiveTab(2, 'wt-1')

    await expect(b.tabSwitch(undefined, undefined, 'tab-a')).resolves.toEqual({
      switched: 0,
      browserPageId: 'tab-a'
    })
    expect(b.tabList('wt-1').tabs).toMatchObject([
      { browserPageId: 'tab-a', active: true },
      { browserPageId: 'tab-b', active: false }
    ])
  })

  it('queues tabSwitch behind in-flight commands on the current session', async () => {
    const tabs = new Map([
      ['tab-a', 1],
      ['tab-b', 2]
    ])
    const worktrees = new Map([
      ['tab-a', 'wt-1'],
      ['tab-b', 'wt-1']
    ])
    const wc1 = mockWebContents(1)
    const wc2 = mockWebContents(2)
    webContentsFromIdMock.mockImplementation((id: number) =>
      id === 1 ? wc1 : id === 2 ? wc2 : null
    )

    const b = new AgentBrowserBridge(mockBrowserManager(tabs, worktrees))
    b.setActiveTab(1, 'wt-1')

    let releaseSnapshot: (() => void) | null = null
    execFileMock.mockImplementation(
      (_bin: string, args: string[], _opts: unknown, cb: Function) => {
        if (args.includes('close')) {
          cb(null, JSON.stringify({ success: true, data: null }), '')
          return
        }
        if (args.includes('snapshot')) {
          releaseSnapshot = () => {
            cb(null, JSON.stringify({ success: true, data: { snapshot: 'tree' } }), '')
          }
          return
        }
        cb(null, JSON.stringify({ success: true, data: { ok: true } }), '')
      }
    )

    const snapshot = b.snapshot('wt-1')
    const switched = b.tabSwitch(1, 'wt-1')

    await Promise.resolve()
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(b.getActiveWebContentsId()).toBe(1)
    expect(releaseSnapshot).not.toBeNull()

    releaseSnapshot!()
    await expect(snapshot).resolves.toEqual({ browserPageId: 'tab-a', snapshot: 'tree' })
    await expect(switched).resolves.toEqual({ switched: 1, browserPageId: 'tab-b' })
    expect(b.getActiveWebContentsId()).toBe(2)
  })

  // ── goto command ──

  it('navigates the registered webContents without spawning agent-browser', async () => {
    const wc = mockWebContents(100, 'https://example.com/start', 'Example')
    webContentsFromIdMock.mockReturnValue(wc)

    await expect(bridge.goto('https://example.com/next')).resolves.toEqual({
      url: 'https://example.com/next',
      title: 'Example'
    })

    expect(wc.loadURL).toHaveBeenCalledWith('https://example.com/next')
    expect(wc.isLoading).not.toHaveBeenCalled()
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('preserves scheme-less navigation semantics at the direct WebContents boundary', async () => {
    const wc = mockWebContents(100)
    webContentsFromIdMock.mockReturnValue(wc)

    await expect(bridge.goto('example.com')).resolves.toEqual({
      url: 'https://example.com/',
      title: 'Example'
    })
    expect(wc.loadURL).toHaveBeenCalledWith('https://example.com/')
  })

  it('rejects unsupported direct navigation URLs without falling back to agent-browser', async () => {
    const wc = mockWebContents(100)
    webContentsFromIdMock.mockReturnValue(wc)

    await expect(bridge.goto('javascript:alert(1)')).rejects.toMatchObject({
      code: 'invalid_argument',
      message: 'Unsupported browser URL: javascript:alert(1)'
    })
    expect(wc.loadURL).not.toHaveBeenCalled()
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('fails closed and releases the command queue when direct navigation never settles', async () => {
    vi.useFakeTimers()
    try {
      const wc = mockWebContents(100)
      wc.loadURL.mockReturnValue(new Promise<void>(() => {}))
      webContentsFromIdMock.mockReturnValue(wc)

      const navigation = bridge.goto('https://example.com/hangs')
      const rejection = expect(navigation).rejects.toMatchObject({
        code: 'browser_error',
        message: 'Failed to navigate browser page tab-1: Browser navigation timed out after 30000ms'
      })
      await vi.advanceTimersByTimeAsync(30_000)

      await rejection
      expect(execFileMock).not.toHaveBeenCalled()
      expect(
        (bridge as unknown as { commandQueues: Map<string, unknown[]> }).commandQueues.size
      ).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits for a superseding navigation to land after direct navigation aborts', async () => {
    const wc = mockWebContents(100, 'https://example.com/current', 'Example')
    let currentUrl = 'https://example.com/current'
    let loading = true
    const listeners = new Map<string, () => void>()
    wc.getURL = () => currentUrl
    wc.isLoading.mockImplementation(() => loading)
    wc.on.mockImplementation((event: string, listener: () => void) => {
      listeners.set(event, listener)
    })
    wc.loadURL.mockRejectedValue(
      Object.assign(new Error('ERR_ABORTED (-3)'), { code: 'ERR_ABORTED', errno: -3 })
    )
    webContentsFromIdMock.mockReturnValue(wc)

    const navigation = bridge.goto('https://example.com/sso')
    await vi.waitFor(() => expect(listeners.get('did-stop-loading')).toBeDefined())

    currentUrl = 'https://example.com/login'
    loading = false
    listeners.get('did-stop-loading')!()

    await expect(navigation).resolves.toEqual({
      url: 'https://example.com/login',
      title: 'Example'
    })
    expect(wc.removeListener).toHaveBeenCalledWith(
      'did-stop-loading',
      listeners.get('did-stop-loading')
    )
    expect(wc.removeListener).toHaveBeenCalledWith('destroyed', listeners.get('destroyed'))
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('resolves with the unchanged page when a download-triggered load aborts', async () => {
    const wc = mockWebContents(100, 'https://example.com/current', 'Example')
    wc.loadURL.mockRejectedValue(Object.assign(new Error('ERR_ABORTED (-3)'), { errno: -3 }))
    webContentsFromIdMock.mockReturnValue(wc)

    await expect(bridge.goto('https://example.com/download')).resolves.toEqual({
      url: 'https://example.com/current',
      title: 'Example'
    })
    expect(wc.isLoading).toHaveBeenCalledTimes(1)
    expect(wc.on).not.toHaveBeenCalledWith('did-stop-loading', expect.any(Function))
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('fails closed when the page prevents direct navigation', async () => {
    const wc = mockWebContents(100, 'https://example.com/unsaved', 'Unsaved changes')
    wc.loadURL.mockImplementation(async () => {
      const preventUnload = wc.on.mock.calls.find(
        ([event]) => event === 'will-prevent-unload'
      )?.[1] as ((event: { defaultPrevented: boolean }) => void) | undefined
      preventUnload!({ defaultPrevented: false })
      throw Object.assign(new Error('ERR_ABORTED (-3)'), { code: 'ERR_ABORTED', errno: -3 })
    })
    webContentsFromIdMock.mockReturnValue(wc)

    await expect(bridge.goto('https://example.com/next')).rejects.toMatchObject({
      code: 'browser_error',
      message: 'Failed to navigate browser page tab-1: ERR_ABORTED (-3)'
    })
    const preventUnload = wc.on.mock.calls.find(([event]) => event === 'will-prevent-unload')?.[1]
    expect(wc.removeListener).toHaveBeenCalledWith('will-prevent-unload', preventUnload)
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('fails closed when the navigation superseding an abort fails', async () => {
    const wc = mockWebContents(100, 'https://example.com/current', 'Example')
    wc.loadURL.mockRejectedValue(
      Object.assign(new Error('ERR_ABORTED (-3)'), { code: 'ERR_ABORTED', errno: -3 })
    )
    webContentsFromIdMock.mockReturnValue(wc)
    const getBrowserPageLoadError = vi.fn(() => ({
      code: -105,
      description: 'Name not resolved',
      validatedUrl: 'https://nxdomain.example/'
    }))
    const b = new AgentBrowserBridge(
      mockBrowserManager(new Map([['tab-1', 100]]), undefined, {
        getBrowserPageLoadError
      })
    )
    b.setActiveTab(100)

    await expect(b.goto('https://example.com/redirect')).rejects.toMatchObject({
      code: 'browser_error',
      message: 'Failed to navigate browser page tab-1: Name not resolved (-105)'
    })
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('bounds and cleans up a superseding navigation that never settles', async () => {
    vi.useFakeTimers()
    try {
      const wc = mockWebContents(100, 'https://example.com/current', 'Example')
      wc.isLoading.mockReturnValue(true)
      wc.loadURL.mockRejectedValue(
        Object.assign(new Error('ERR_ABORTED (-3)'), { code: 'ERR_ABORTED', errno: -3 })
      )
      webContentsFromIdMock.mockReturnValue(wc)

      const navigation = bridge.goto('https://example.com/redirect')
      const rejection = expect(navigation).rejects.toMatchObject({
        code: 'browser_error',
        message: 'Failed to navigate browser page tab-1: Browser navigation timed out after 30000ms'
      })
      await vi.advanceTimersByTimeAsync(30_000)

      await rejection
      const stopLoading = wc.on.mock.calls.find(([event]) => event === 'did-stop-loading')?.[1]
      const destroyed = wc.on.mock.calls.find(([event]) => event === 'destroyed')?.[1]
      expect(wc.removeListener).toHaveBeenCalledWith('did-stop-loading', stopLoading)
      expect(wc.removeListener).toHaveBeenCalledWith('destroyed', destroyed)
      expect(vi.getTimerCount()).toBe(0)
      expect(
        (bridge as unknown as { commandQueues: Map<string, unknown[]> }).commandQueues.size
      ).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cleans up when the guest is destroyed while attaching the replacement wait', async () => {
    vi.useFakeTimers()
    try {
      const wc = mockWebContents(100, 'https://example.com/current', 'Example')
      let destroyed = false
      wc.isDestroyed = () => destroyed
      wc.isLoading.mockReturnValueOnce(true).mockImplementationOnce(() => {
        destroyed = true
        throw new Error('Object has been destroyed')
      })
      wc.loadURL.mockRejectedValue(
        Object.assign(new Error('ERR_ABORTED (-3)'), { code: 'ERR_ABORTED', errno: -3 })
      )
      webContentsFromIdMock.mockReturnValue(wc)

      await expect(bridge.goto('https://example.com/redirect')).rejects.toMatchObject({
        code: 'browser_tab_not_found',
        message: 'Browser page tab-1 is no longer available'
      })

      const stopLoading = wc.on.mock.calls.find(([event]) => event === 'did-stop-loading')?.[1]
      const destroyedListener = wc.on.mock.calls.find(([event]) => event === 'destroyed')?.[1]
      expect(wc.removeListener).toHaveBeenCalledWith('did-stop-loading', stopLoading)
      expect(wc.removeListener).toHaveBeenCalledWith('destroyed', destroyedListener)
      expect(vi.getTimerCount()).toBe(0)
      expect(
        (bridge as unknown as { commandQueues: Map<string, unknown[]> }).commandQueues.size
      ).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails closed when direct navigation fails for a non-abort reason', async () => {
    const wc = mockWebContents(100, 'https://example.com/current', 'Example')
    wc.loadURL.mockRejectedValue(
      Object.assign(new Error('ERR_NAME_NOT_RESOLVED (-105)'), {
        code: 'ERR_NAME_NOT_RESOLVED',
        errno: -105
      })
    )
    webContentsFromIdMock.mockReturnValue(wc)

    await expect(bridge.goto('https://nxdomain.example')).rejects.toMatchObject({
      code: 'browser_error',
      message: 'Failed to navigate browser page tab-1: ERR_NAME_NOT_RESOLVED (-105)'
    })
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it.each([
    {
      command: 'goto',
      run: (b: AgentBrowserBridge) => b.goto('https://embedded.example/next'),
      helperArg: 'goto',
      directMethod: 'loadURL'
    },
    {
      command: 'evaluate',
      run: (b: AgentBrowserBridge) => b.evaluate('document.title'),
      helperArg: 'eval',
      directMethod: 'Runtime.evaluate'
    }
  ])(
    'does not route $command to another browser when the helper session is stale',
    async ({ run, helperArg, directMethod }) => {
      const wc = mockWebContents(100, 'https://embedded.example/current', 'Embedded')
      wc.debugger.sendCommand.mockImplementation(async (_method: string, params?: unknown) => ({
        result: {
          value:
            (params as { expression?: string } | undefined)?.expression === 'location.origin'
              ? 'https://embedded.example'
              : 'Embedded'
        }
      }))
      webContentsFromIdMock.mockReturnValue(wc)
      const wrongOwnerCalls: string[][] = []
      let helperSessionIsStale = false

      execFileMock.mockImplementation(
        (_bin: string, args: string[], _opts: unknown, cb: Function) => {
          if (args.includes('close')) {
            cb(null, JSON.stringify({ success: true, data: null }), '')
          } else if (args.includes('snapshot')) {
            cb(null, JSON.stringify({ success: true, data: { snapshot: 'ready' } }), '')
          } else {
            if (helperSessionIsStale && !args.includes('--cdp')) {
              wrongOwnerCalls.push(args)
            }
            cb(
              null,
              JSON.stringify({
                success: true,
                data: { url: 'https://external.example', title: 'External', result: 'external' }
              }),
              ''
            )
          }
          return { kill: vi.fn() }
        }
      )

      await bridge.snapshot()
      helperSessionIsStale = true
      await run(bridge)

      expect(wrongOwnerCalls).toEqual([])
      expect(
        execFileMock.mock.calls.some((call) => (call[1] as string[]).includes(helperArg))
      ).toBe(false)
      if (directMethod === 'loadURL') {
        expect(wc.loadURL).toHaveBeenCalledWith('https://embedded.example/next')
      } else {
        expect(wc.debugger.sendCommand).toHaveBeenCalledWith(
          'Runtime.evaluate',
          expect.objectContaining({ expression: 'document.title' })
        )
      }
    }
  )

  it('returns direct evaluation value and full page URL semantics without spawning agent-browser', async () => {
    const wc = mockWebContents(100, 'https://example.com/path?query=1')
    wc.debugger.sendCommand.mockResolvedValue({ result: { value: 42 } })
    webContentsFromIdMock.mockReturnValue(wc)

    await expect(bridge.evaluate('6 * 7')).resolves.toEqual({
      result: '42',
      origin: 'https://example.com/path?query=1'
    })
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it.each([
    [{ answer: 42 }, '{"answer":42}'],
    [['a', 'b'], '["a","b"]']
  ])('preserves structured direct evaluation values as JSON text', async (value, expected) => {
    const wc = mockWebContents(100)
    wc.debugger.sendCommand.mockResolvedValue({ result: { value } })
    webContentsFromIdMock.mockReturnValue(wc)

    await expect(bridge.evaluate('structuredValue')).resolves.toMatchObject({ result: expected })
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('surfaces direct evaluation exceptions without falling back to agent-browser', async () => {
    const wc = mockWebContents(100)
    wc.debugger.sendCommand.mockResolvedValue({
      result: { type: 'object' },
      exceptionDetails: {
        text: 'Uncaught',
        exception: { description: 'ReferenceError: missingValue is not defined' }
      }
    })
    webContentsFromIdMock.mockReturnValue(wc)

    await expect(bridge.evaluate('missingValue')).rejects.toMatchObject({
      code: 'browser_eval_error',
      message: 'ReferenceError: missingValue is not defined'
    })
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('fails closed when the registered webContents debugger is stale', async () => {
    const wc = mockWebContents(100)
    wc.debugger.sendCommand.mockRejectedValue(new Error('Debugger is detached'))
    webContentsFromIdMock.mockReturnValue(wc)

    await expect(bridge.evaluate('document.title')).rejects.toMatchObject({
      code: 'browser_error',
      message: 'Failed to evaluate in browser page tab-1: Debugger is detached'
    })
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it.each([
    ['goto', (b: AgentBrowserBridge) => b.goto('https://example.com/next', undefined, 'tab-1')],
    ['evaluate', (b: AgentBrowserBridge) => b.evaluate('document.title', undefined, 'tab-1')]
  ])('fails closed when direct %s targets a destroyed webContents', async (_command, run) => {
    const wc = mockWebContents(100)
    wc.isDestroyed = () => true
    webContentsFromIdMock.mockReturnValue(wc)
    const unregisterGuest = vi.fn()
    const b = new AgentBrowserBridge(
      mockBrowserManager(new Map([['tab-1', 100]]), new Map(), { unregisterGuest })
    )
    b.setActiveTab(100)

    await expect(run(b)).rejects.toMatchObject({
      code: 'browser_tab_not_found',
      message: 'Browser page tab-1 is no longer available'
    })
    expect(unregisterGuest).toHaveBeenCalledWith('tab-1')
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('returns navigation state from a replacement registered during load', async () => {
    const tabs = new Map([['tab-1', 100]])
    const oldWc = mockWebContents(100, 'https://example.com/start', 'Old')
    const replacementWc = mockWebContents(200, 'https://example.com/final', 'Replacement')
    oldWc.loadURL.mockImplementation(async () => {
      tabs.set('tab-1', 200)
    })
    webContentsFromIdMock.mockImplementation((id: number) =>
      id === 100 ? oldWc : id === 200 ? replacementWc : null
    )
    const b = new AgentBrowserBridge(mockBrowserManager(tabs))
    b.setActiveTab(100)

    await expect(b.goto('https://example.com/next')).resolves.toEqual({
      url: 'https://example.com/final',
      title: 'Replacement'
    })
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('routes direct commands to the replacement registration, not the stale session owner', async () => {
    const tabs = new Map([['tab-1', 100]])
    const oldWc = mockWebContents(100, 'https://old.example', 'Old')
    const replacementWc = mockWebContents(200, 'https://new.example', 'New')
    replacementWc.debugger.sendCommand.mockImplementation(
      async (_method: string, params?: unknown) => ({
        result: {
          value:
            (params as { expression?: string } | undefined)?.expression === 'location.origin'
              ? 'https://new.example'
              : 'New'
        }
      })
    )
    webContentsFromIdMock.mockImplementation((id: number) =>
      id === 100 ? oldWc : id === 200 ? replacementWc : null
    )
    const b = new AgentBrowserBridge(mockBrowserManager(tabs))
    b.setActiveTab(100)

    succeedWith({ snapshot: 'ready' })
    await b.snapshot()
    tabs.set('tab-1', 200)
    await b.onProcessSwap('tab-1', 200, 100)
    execFileMock.mockClear()

    await expect(b.evaluate('document.title', undefined, 'tab-1')).resolves.toEqual({
      result: 'New',
      origin: 'https://new.example'
    })
    expect(replacementWc.debugger.sendCommand).toHaveBeenCalledWith(
      'Runtime.evaluate',
      expect.objectContaining({ expression: 'document.title' })
    )
    expect(oldWc.debugger.sendCommand).not.toHaveBeenCalled()
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('rejects oversized browser clipboard writes before spawning agent-browser', async () => {
    const secret = 'browser-clipboard-secret'
    succeedWith({ ok: true })

    await expect(
      bridge.clipboardWrite(secret + 'x'.repeat(CLIPBOARD_TEXT_WRITE_MAX_BYTES + 1))
    ).rejects.toThrow(CLIPBOARD_TEXT_WRITE_TOO_LARGE_ERROR)

    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('rejects browser clipboard writes that exceed the safe agent-browser argument size', async () => {
    succeedWith({ ok: true })

    await expect(
      bridge.clipboardWrite('x'.repeat(AGENT_BROWSER_CLIPBOARD_WRITE_MAX_BYTES + 1))
    ).rejects.toThrow(CLIPBOARD_TEXT_WRITE_TOO_LARGE_ERROR)

    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('builds valid fill eval JavaScript for multiline values', async () => {
    succeedWith({ ok: true })

    await bridge.fill('@textarea', "line one\nline two with 'quote' and \\ slash")

    const evalCall = execFileMock.mock.calls.find((call: unknown[]) =>
      (call[1] as string[]).includes('eval')
    )
    expect(evalCall).toBeDefined()
    const args = evalCall![1] as string[]
    const expression = args[args.indexOf('eval') + 1]
    expect(() => new Function(expression)).not.toThrow()
  })

  it('replaces contenteditable text through the browser editing pipeline', async () => {
    succeedForContentEditable()
    const environment = createContentEditableEvalEnvironment('existing text')

    await bridge.fill('@editor', 'replacement text')

    runFillEvalExpressions(stdinWrites, environment.document, environment.windowObject)

    expect(environment.editor.textContent).toBe('replacement text')
    expect(environment.execCommand).toHaveBeenCalledWith('insertText', false, 'replacement text')
    expect(environment.editor.dispatchEvent).not.toHaveBeenCalled()
  })

  it('clears selected contenteditable text with a browser delete command', async () => {
    succeedForContentEditable()
    const environment = createContentEditableEvalEnvironment('existing text')

    const result = await bridge.clear('@editor')

    runFillEvalExpressions(stdinWrites, environment.document, environment.windowObject)

    expect(environment.editor.textContent).toBe('')
    expect(environment.execCommand).toHaveBeenCalledWith('delete', false, '')
    expect(environment.editor.dispatchEvent).not.toHaveBeenCalled()
    expect(result).toEqual({ cleared: '@editor' })
  })

  it('fails contenteditable fill when the browser editing command is unavailable', async () => {
    succeedForContentEditable()
    const environment = createContentEditableEvalEnvironment('existing text')
    environment.execCommand.mockReturnValue(false)

    await bridge.fill('@editor', 'replacement text')

    expect(() =>
      runFillEvalExpressions(stdinWrites, environment.document, environment.windowObject)
    ).toThrow('Browser rich-text editing command failed')
    expect(environment.editor.textContent).toBe('existing text')
    expect(environment.editor.dispatchEvent).not.toHaveBeenCalled()
  })

  it('inserts paste-sized contenteditable text as one stdin editing transaction', async () => {
    const firstChunk = 'x'.repeat(AGENT_BROWSER_TEXT_ARGUMENT_MAX_BYTES)
    succeedForContentEditable()
    const environment = createContentEditableEvalEnvironment('existing text')

    await bridge.fill('@editor', `${firstChunk}tail`)

    const evalCalls = execFileMock.mock.calls.filter((call: unknown[]) =>
      (call[1] as string[]).includes('eval')
    )
    runFillEvalExpressions(stdinWrites, environment.document, environment.windowObject)

    expect(evalCalls).toHaveLength(1)
    expect(evalCalls[0][1]).toContain('--stdin')
    expect(stdinWrites).toHaveLength(1)
    expect(environment.editor.textContent).toBe(`${firstChunk}tail`)
  })

  it('uses target-aware agent-browser fill when clearing a non-rich target', async () => {
    succeedWith({ filled: '@disabled' })

    const result = await bridge.clear('@disabled')

    const commandArgs = execFileMock.mock.calls.map((call: unknown[]) => call[1] as string[])
    expect(commandArgs.some((args) => args.includes('eval'))).toBe(false)
    expect(commandArgs.some((args) => args.includes('fill') && args.includes('@disabled'))).toBe(
      true
    )
    expect(result).toEqual({ cleared: '@disabled' })
  })

  it('routes focused spinbutton wrappers to editable descendants before filling', async () => {
    succeedWith({ ok: true })

    await bridge.fill('@spinbutton', '200')

    const expressions = execFileMock.mock.calls
      .filter((call: unknown[]) => (call[1] as string[]).includes('eval'))
      .map((call: unknown[]) => {
        const args = call[1] as string[]
        return args[args.indexOf('eval') + 1]
      })

    const input = createFillEvalNode({ tagName: 'INPUT' })
    const wrapper = createFillEvalNode({
      tagName: 'DIV',
      role: 'spinbutton',
      descendant: input.node
    })

    runFillEvalExpressions(expressions, {
      activeElement: wrapper.node,
      getElementById: () => null
    })

    expect(input.value).toBe('200')
    expect(wrapper.value).toBe('')
    expect(input.events.map((event) => event.type)).toEqual(['input', 'change'])
    expect(wrapper.events).toHaveLength(0)
  })

  it('routes aria-controlled spinbutton wrappers to editable inputs before filling', async () => {
    succeedWith({ ok: true })

    await bridge.fill('@spinbutton', '200')

    const expressions = execFileMock.mock.calls
      .filter((call: unknown[]) => (call[1] as string[]).includes('eval'))
      .map((call: unknown[]) => {
        const args = call[1] as string[]
        return args[args.indexOf('eval') + 1]
      })

    const input = createFillEvalNode({ tagName: 'INPUT' })
    const wrapper = createFillEvalNode({
      tagName: 'DIV',
      role: 'spinbutton',
      ariaControls: 'target-id'
    })

    runFillEvalExpressions(expressions, {
      activeElement: wrapper.node,
      getElementById: (id: string) => (id === 'target-id' ? input.node : null)
    })

    expect(input.value).toBe('200')
    expect(wrapper.value).toBe('')
    expect(input.events.map((event) => event.type)).toEqual(['input', 'change'])
    expect(wrapper.events).toHaveLength(0)
  })

  it('routes aria-controlled spinbutton containers to editable descendants before filling', async () => {
    succeedWith({ ok: true })

    await bridge.fill('@spinbutton', '200')

    const expressions = execFileMock.mock.calls
      .filter((call: unknown[]) => (call[1] as string[]).includes('eval'))
      .map((call: unknown[]) => {
        const args = call[1] as string[]
        return args[args.indexOf('eval') + 1]
      })

    const input = createFillEvalNode({ tagName: 'INPUT' })
    const controlled = createFillEvalNode({ tagName: 'DIV', descendant: input.node })
    const wrapper = createFillEvalNode({
      tagName: 'DIV',
      role: 'spinbutton',
      ariaControls: 'target-id'
    })

    runFillEvalExpressions(expressions, {
      activeElement: wrapper.node,
      getElementById: (id: string) => (id === 'target-id' ? controlled.node : null)
    })

    expect(input.value).toBe('200')
    expect(controlled.value).toBe('')
    expect(wrapper.value).toBe('')
    expect(input.events.map((event) => event.type)).toEqual(['input', 'change'])
    expect(controlled.events).toHaveLength(0)
    expect(wrapper.events).toHaveLength(0)
  })

  it('skips non-text spinbutton descendant inputs before filling', async () => {
    succeedWith({ ok: true })

    await bridge.fill('@spinbutton', '200')

    const expressions = execFileMock.mock.calls
      .filter((call: unknown[]) => (call[1] as string[]).includes('eval'))
      .map((call: unknown[]) => {
        const args = call[1] as string[]
        return args[args.indexOf('eval') + 1]
      })

    const hiddenInput = createFillEvalNode({ tagName: 'INPUT', type: 'hidden' })
    const numberInput = createFillEvalNode({ tagName: 'INPUT', type: 'number' })
    const wrapper = createFillEvalNode({
      tagName: 'DIV',
      role: 'spinbutton',
      descendants: [hiddenInput.node, numberInput.node]
    })

    runFillEvalExpressions(expressions, {
      activeElement: wrapper.node,
      getElementById: () => null
    })

    expect(numberInput.value).toBe('200')
    expect(hiddenInput.value).toBe('')
    expect(wrapper.value).toBe('')
    expect(numberInput.events.map((event) => event.type)).toEqual(['input', 'change'])
    expect(hiddenInput.events).toHaveLength(0)
    expect(wrapper.events).toHaveLength(0)
  })

  it('keeps plain focused inputs as fill targets', async () => {
    succeedWith({ ok: true })

    await bridge.fill('@input', '200')

    const expressions = execFileMock.mock.calls
      .filter((call: unknown[]) => (call[1] as string[]).includes('eval'))
      .map((call: unknown[]) => {
        const args = call[1] as string[]
        return args[args.indexOf('eval') + 1]
      })

    const input = createFillEvalNode({ tagName: 'INPUT' })

    runFillEvalExpressions(expressions, {
      activeElement: input.node,
      getElementById: () => null
    })

    expect(input.value).toBe('200')
    expect(input.events.map((event) => event.type)).toEqual(['input', 'change'])
  })

  it('chunks large agent-browser fill values before eval transport', async () => {
    const text = ['x'.repeat(AGENT_BROWSER_TEXT_ARGUMENT_MAX_BYTES), 'tail'].join('')
    succeedWith({ ok: true })

    await bridge.fill('@textarea', text)

    const evalCalls = execFileMock.mock.calls.filter((call: unknown[]) =>
      (call[1] as string[]).includes('eval')
    )
    const appendExpressions = evalCalls.slice(1, -1).map((call: unknown[]) => {
      const args = call[1] as string[]
      return args[args.indexOf('eval') + 1]
    })

    expect(appendExpressions).toHaveLength(2)
    expect(appendExpressions.some((expression) => expression.includes(text))).toBe(false)
    expect(appendExpressions[0]).toContain('x'.repeat(AGENT_BROWSER_TEXT_ARGUMENT_MAX_BYTES))
    expect(appendExpressions[1]).toContain('tail')
  })

  it.each([
    ['fill', (b: AgentBrowserBridge, text: string) => b.fill('@textarea', text)],
    ['type', (b: AgentBrowserBridge, text: string) => b.type(text)],
    ['keyboard insert', (b: AgentBrowserBridge, text: string) => b.keyboardInsertText(text)]
  ])('yields before spawning agent-browser for accepted large %s text', async (_name, run) => {
    vi.useFakeTimers()
    try {
      const text = 'é'.repeat(CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS + 1)
      succeedWith({ ok: true })

      const pending = run(bridge, text)
      await Promise.resolve()

      expect(execFileMock).not.toHaveBeenCalled()

      await vi.runOnlyPendingTimersAsync()
      await pending

      expect(execFileMock).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('chunks large agent-browser type text before keyboard transport', async () => {
    const text = ['y'.repeat(AGENT_BROWSER_TEXT_ARGUMENT_MAX_BYTES), 'zz'].join('')
    succeedWith({ typed: true })

    await bridge.type(text)

    const typeCalls = execFileMock.mock.calls.filter((call: unknown[]) => {
      const args = call[1] as string[]
      return args.includes('keyboard') && args.includes('type')
    })
    const chunks = typeCalls.map((call: unknown[]) => {
      const args = call[1] as string[]
      return args[args.indexOf('type') + 1]
    })

    expect(chunks).toEqual(['y'.repeat(AGENT_BROWSER_TEXT_ARGUMENT_MAX_BYTES), 'zz'])
  })

  it('chunks large agent-browser keyboard insert text before transport', async () => {
    const text = ['z'.repeat(AGENT_BROWSER_TEXT_ARGUMENT_MAX_BYTES), 'qq'].join('')
    succeedWith({ inserted: true })

    await bridge.keyboardInsertText(text)

    const insertTextCalls = execFileMock.mock.calls.filter((call: unknown[]) => {
      const args = call[1] as string[]
      return args.includes('keyboard') && args.includes('inserttext')
    })
    const chunks = insertTextCalls.map((call: unknown[]) => {
      const args = call[1] as string[]
      return args[args.indexOf('inserttext') + 1]
    })

    expect(chunks).toEqual(['z'.repeat(AGENT_BROWSER_TEXT_ARGUMENT_MAX_BYTES), 'qq'])
  })

  // ── Cross-worktree text-injection guard ──

  describe('scoped target for text-mutating commands', () => {
    function twoWorktreeBridge(): AgentBrowserBridge {
      const tabs = new Map([
        ['tab-a', 1],
        ['tab-b', 2]
      ])
      const worktrees = new Map([
        ['tab-a', 'wt-1'],
        ['tab-b', 'wt-2']
      ])
      const wc1 = mockWebContents(1, 'https://a.com', 'A')
      const wc2 = mockWebContents(2, 'https://b.com', 'B')
      webContentsFromIdMock.mockImplementation((id: number) => (id === 1 ? wc1 : wc2))
      return new AgentBrowserBridge(mockBrowserManager(tabs, worktrees))
    }

    function sessionNamesUsed(): string[] {
      return execFileMock.mock.calls
        .filter((call: unknown[]) => (call[1] as string[]).includes('--session'))
        .map((call: unknown[]) => {
          const args = call[1] as string[]
          return args[args.indexOf('--session') + 1]
        })
    }

    it.each([
      ['inserttext', (b: AgentBrowserBridge) => b.keyboardInsertText('x', undefined, undefined)],
      ['type', (b: AgentBrowserBridge) => b.type('x', undefined, undefined)],
      ['fill', (b: AgentBrowserBridge) => b.fill('@input', 'x', undefined, undefined)]
    ])(
      'refuses %s when worktrees are ambiguous instead of routing to the global active tab',
      async (_name, run) => {
        const b = twoWorktreeBridge()
        // Why: simulates the user viewing worktree B's tab, which sets the global
        // active webContents — the bug would route the agent's text there.
        b.onTabChanged(2, 'wt-2')
        succeedWith({ inserted: true })

        await expect(run(b)).rejects.toMatchObject({
          code: 'browser_target_ambiguous'
        })
        // Must not have dispatched the command to worktree B's session.
        expect(sessionNamesUsed()).not.toContain('orca-tab-tab-b')
      }
    )

    it('auto-scopes inserttext to the lone worktree that has a live tab', async () => {
      const tabs = new Map([['tab-a', 1]])
      const worktrees = new Map([['tab-a', 'wt-1']])
      const wc1 = mockWebContents(1, 'https://a.com', 'A')
      webContentsFromIdMock.mockReturnValue(wc1)
      const b = new AgentBrowserBridge(mockBrowserManager(tabs, worktrees))
      succeedWith({ inserted: true })

      await b.keyboardInsertText('x', undefined, undefined)

      expect(sessionNamesUsed()).toContain('orca-tab-tab-a')
    })

    it('throws browser_no_tab for inserttext when no live tab exists', async () => {
      const b = new AgentBrowserBridge(mockBrowserManager(new Map()))
      await expect(b.keyboardInsertText('x', undefined, undefined)).rejects.toMatchObject({
        code: 'browser_no_tab'
      })
    })

    it('keeps read-only snapshot on the lenient global active-tab fallback', async () => {
      const b = twoWorktreeBridge()
      // Why: read/navigation commands intentionally keep the global fallback so
      // discovery still works without a worktree; only text writes are guarded.
      b.onTabChanged(2, 'wt-2')
      succeedWith({ snapshot: 'tree' })

      await b.snapshot(undefined, undefined)

      expect(sessionNamesUsed()).toContain('orca-tab-tab-b')
    })
  })

  // ── Cookie command arg building ──

  it('builds cookie set args with all options', async () => {
    succeedWith({ success: true })
    await bridge.cookieSet({
      name: 'sid',
      value: 'abc',
      domain: '.example.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
      expires: 1700000000
    })

    const args = execFileMock.mock.calls.at(-1)![1] as string[]
    expect(args).toContain('cookies')
    expect(args).toContain('set')
    expect(args).toContain('sid')
    expect(args).toContain('abc')
    expect(args).toContain('--domain')
    expect(args).toContain('.example.com')
    expect(args).toContain('--path')
    expect(args).toContain('/')
    expect(args).toContain('--secure')
    expect(args).toContain('--httpOnly')
    expect(args).toContain('--sameSite')
    expect(args).toContain('Lax')
    expect(args).toContain('--expires')
    expect(args).toContain('1700000000')
  })

  // ── Viewport command arg building ──

  it('applies viewport emulation through CDP so mobile mode is preserved', async () => {
    const wc = mockWebContents(100)
    webContentsFromIdMock.mockReturnValue(wc)

    await bridge.setViewport(375, 812, 2, true)

    expect(wc.debugger.sendCommand).toHaveBeenCalledWith('Emulation.setDeviceMetricsOverride', {
      width: 375,
      height: 812,
      deviceScaleFactor: 2,
      mobile: true
    })
    expect(wc.debugger.sendCommand).toHaveBeenCalledWith('Emulation.setVisibleSize', {
      width: 375,
      height: 812
    })
    const viewportCall = execFileMock.mock.calls.find((call: unknown[]) =>
      (call[1] as string[]).includes('viewport')
    )
    expect(viewportCall).toBeUndefined()
  })

  it('normalizes selector wait state=visible to the default supported semantics', async () => {
    succeedWith({ selector: 'h1', waited: 'selector' })

    await bridge.wait({ selector: 'h1', state: 'visible' })

    const args = execFileMock.mock.calls.at(-1)![1] as string[]
    expect(args).toContain('wait')
    expect(args).toContain('h1')
    expect(args).not.toContain('--state')
  })

  it('enforces conditional wait timeouts at the bridge layer', async () => {
    succeedWith({ selector: '#ready', waited: 'selector' })

    await bridge.wait({ selector: '#ready', timeout: 1200 })

    const args = execFileMock.mock.calls.at(-1)![1] as string[]
    const options = execFileMock.mock.calls.at(-1)![2] as { timeout?: number; env?: unknown }
    expect(args).toContain('wait')
    expect(args).toContain('#ready')
    expect(options.timeout).toBe(2200)
    expect(options.env).toBe(process.env)
  })

  it('returns browser_timeout for timed conditional waits without recycling the session', async () => {
    const killedError = Object.assign(new Error('timeout'), { killed: true })
    execFileMock.mockImplementation(
      (_bin: string, args: string[], _opts: unknown, cb: Function) => {
        if (args.includes('wait')) {
          cb(killedError, '', '')
          return
        }
        cb(null, JSON.stringify({ success: true, data: { snapshot: 'fresh' } }), '')
      }
    )

    for (let i = 0; i < 3; i++) {
      await expect(bridge.wait({ selector: '.missing', timeout: 1200 })).rejects.toThrow(
        'Timed out waiting for browser condition after 1200ms.'
      )
    }

    await bridge.snapshot()

    expect(CdpWsProxyMock.instances).toHaveLength(1)
  })

  // ── Stderr passthrough on non-timeout errors ──

  it('passes stderr through as error message on execFile failure', async () => {
    execFileMock.mockImplementation(
      (_bin: string, args: string[], _opts: unknown, cb: Function) => {
        if (args.includes('close')) {
          cb(null, JSON.stringify({ success: true, data: null }), '')
          return
        }
        cb(new Error('exit code 1'), '', 'daemon crashed: segfault')
      }
    )
    await expect(bridge.snapshot()).rejects.toThrow('daemon crashed: segfault')
  })

  it('falls back to error.message when stderr is empty', async () => {
    execFileMock.mockImplementation(
      (_bin: string, args: string[], _opts: unknown, cb: Function) => {
        if (args.includes('close')) {
          cb(null, JSON.stringify({ success: true, data: null }), '')
          return
        }
        cb(new Error('Command failed'), '', '')
      }
    )
    await expect(bridge.snapshot()).rejects.toThrow('Command failed')
  })

  // ── Malformed JSON returns BrowserError ──

  it('returns browser_error with truncated output for malformed JSON', async () => {
    execFileMock.mockImplementation(
      (_bin: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, 'Error: not json output', '')
      }
    )
    await expect(bridge.snapshot()).rejects.toThrow('Unexpected output from agent-browser')
  })

  // ── destroyAllSessions ──

  it('destroys all active sessions', async () => {
    succeedWith({ snapshot: 'tree' })
    await bridge.snapshot()

    // Should have one session now
    succeedWith(null) // for the 'close' call
    await bridge.destroyAllSessions()

    // Next command should re-create session with --cdp
    succeedWith({ snapshot: 'fresh' })
    await bridge.snapshot()

    const snapshotCalls = execFileMock.mock.calls.filter((c: unknown[]) =>
      (c[1] as string[]).includes('snapshot')
    )
    const lastSnapshotArgs = snapshotCalls.at(-1)![1] as string[]
    expect(lastSnapshotArgs).toContain('--cdp')
  })
})
