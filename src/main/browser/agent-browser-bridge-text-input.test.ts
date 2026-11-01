import { EventEmitter } from 'node:events'
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
const { capturedElement } = vi.hoisted(() => {
  const capturedElement: { current: { objectId: string; sessionId?: string } | null } = {
    current: null
  }
  return { capturedElement }
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
    this.pointAtNextNode = vi.fn()
    this.elementCapture = { start: vi.fn(), stop: vi.fn(() => capturedElement.current) }
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
import {
  CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS,
  CLIPBOARD_TEXT_WRITE_TOO_LARGE_ERROR
} from '../../shared/clipboard-text'
import {
  agentBrowserCommandsIn,
  createSucceedWith,
  mockBrowserManager,
  mockWebContents,
  overrideBridgeWebContentsLookup,
  resetAgentBrowserBridgeMocks,
  type MockWebContents
} from './agent-browser-bridge-test-harness'
import {
  FILE_INPUT_FRAME_URL_FUNCTION,
  FILE_UPLOAD_TARGET_FUNCTION,
  FILL_ELEMENT_FUNCTION
} from './browser-element-functions'

overrideBridgeWebContentsLookup(AgentBrowserBridge.prototype, webContentsFromIdMock)

const succeedWith = createSucceedWith(execFileMock, stdinWrites)

function elementCalls(wc: MockWebContents): unknown[][] {
  return wc.debugger.sendCommand.mock.calls.filter(
    ([method]) => method === 'Runtime.callFunctionOn'
  )
}

describe('AgentBrowserBridge', () => {
  let bridge: AgentBrowserBridge
  let wc: MockWebContents

  beforeEach(() => {
    capturedElement.current = { objectId: 'element-1', sessionId: 'frame-session' }
    resetAgentBrowserBridgeMocks({
      webContentsFromIdMock,
      existsSyncMock,
      readFileSyncMock,
      stdinWrites,
      cdpWsProxyInstances: CdpWsProxyMock.instances
    })
    bridge = new AgentBrowserBridge(mockBrowserManager())
    bridge.setActiveTab(100)
    wc = mockWebContents(100)
    webContentsFromIdMock.mockImplementation((id: number) => (id === 100 ? wc : null))
  })

  it('rejects browser clipboard writes that exceed the safe agent-browser argument size', async () => {
    succeedWith({ ok: true })

    await expect(
      bridge.clipboardWrite('x'.repeat(AGENT_BROWSER_CLIPBOARD_WRITE_MAX_BYTES + 1))
    ).rejects.toThrow(CLIPBOARD_TEXT_WRITE_TOO_LARGE_ERROR)

    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('fills the element the helper resolved, in its own frame, with one page call', async () => {
    const text = `${'é\n'.repeat(512 * 1024)}tail'\\`
    succeedWith({ value: null })
    wc.debugger.sendCommand.mockResolvedValue({ result: { type: 'object', value: null } })

    await expect(bridge.fill('@e3', text)).resolves.toEqual({ filled: '@e3' })

    expect(agentBrowserCommandsIn(stdinWrites)).toEqual([['get', 'attr', '@e3', 'id']])
    expect(execFileMock.mock.calls.flatMap((call) => call[1]).join('')).not.toContain('tail')
    expect(elementCalls(wc)).toEqual([
      [
        'Runtime.callFunctionOn',
        {
          objectId: 'element-1',
          functionDeclaration: FILL_ELEMENT_FUNCTION,
          arguments: [{ value: text }],
          returnByValue: true
        },
        'frame-session'
      ]
    ])
  })

  it('clears by filling the resolved element with an empty value', async () => {
    succeedWith({ value: null })
    wc.debugger.sendCommand.mockResolvedValue({ result: { type: 'object', value: null } })

    await expect(bridge.clear('@e3')).resolves.toEqual({ cleared: '@e3' })

    expect(elementCalls(wc)[0]?.[1]).toMatchObject({ arguments: [{ value: '' }] })
  })

  it('refuses an element the page function rejects as not interactable', async () => {
    succeedWith({ value: null })
    wc.debugger.sendCommand.mockResolvedValue({
      result: { type: 'string', value: 'it is not a text field or editable element' }
    })

    await expect(bridge.fill('@e1', 'x')).rejects.toMatchObject({
      code: 'browser_element_not_interactable',
      message: 'Cannot fill @e1: it is not a text field or editable element'
    })
  })

  it('fails instead of writing anywhere when the helper resolves no element', async () => {
    capturedElement.current = null
    succeedWith({ value: null })

    await expect(bridge.fill('@e1', 'x')).rejects.toMatchObject({ code: 'browser_error' })
    expect(elementCalls(wc)).toEqual([])
  })

  it('refuses select on an element that is not a <select> before the helper reports success', async () => {
    succeedWith({ selected: ['Mango'] })
    wc.debugger.sendCommand.mockResolvedValue({
      result: { type: 'string', value: 'it is a combobox, not a <select>' }
    })

    await expect(bridge.select('@e9', 'Mango')).rejects.toMatchObject({
      code: 'browser_element_not_interactable'
    })
    expect(agentBrowserCommandsIn(stdinWrites)).toEqual([['get', 'attr', '@e9', 'id']])
  })

  it('refuses to upload a path that is not an existing file', async () => {
    succeedWith({ uploaded: 1 })

    await expect(bridge.upload('@e19', ['/nonexistent/orca-upload.txt'])).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    expect(agentBrowserCommandsIn(stdinWrites)).toEqual([])
  })

  it.each([
    ['its cross-site frame', 'frame-session'],
    ['the page its cross-site frame messages', undefined]
  ])('sets the files on the input a picker button opens in %s', async (_case, chooserSession) => {
    const file = import.meta.filename
    const debuggerEvents = new EventEmitter()
    wc.debugger.on.mockImplementation((event, listener) => void debuggerEvents.on(event, listener))
    wc.debugger.removeListener.mockImplementation(
      (event, listener) => void debuggerEvents.removeListener(event, listener)
    )
    wc.debugger.sendCommand.mockImplementation(async (method, params) => {
      const declaration =
        typeof params === 'object' && params !== null && 'functionDeclaration' in params
          ? params.functionDeclaration
          : null
      if (declaration === FILE_UPLOAD_TARGET_FUNCTION) {
        // The page reports the picker its click opened on the frame's own session.
        const session = chooserSession ?? ''
        debuggerEvents.emit('message', {}, 'Page.fileChooserOpened', { backendNodeId: 7 }, session)
        return { result: { value: false } }
      }
      if (method === 'DOM.resolveNode') {
        return { object: { objectId: 'input-7' } }
      }
      if (declaration === FILE_INPUT_FRAME_URL_FUNCTION) {
        return { result: { value: 'https://widgets.example/picker' } }
      }
      return {}
    })
    succeedWith({ value: null })

    await expect(bridge.upload('@e6', [file])).resolves.toEqual({
      uploaded: 1,
      frameUrl: 'https://widgets.example/picker'
    })

    const sent = wc.debugger.sendCommand.mock.calls
    expect(sent).toContainEqual([
      'DOM.setFileInputFiles',
      { files: [file], objectId: 'input-7' },
      // The page session is Electron's default, so its commands carry no session id.
      ...(chooserSession ? [chooserSession] : [])
    ])
    expect(sent).toContainEqual(['Page.setInterceptFileChooserDialog', { enabled: false }])
    expect(sent).toContainEqual([
      'Page.setInterceptFileChooserDialog',
      { enabled: false },
      'frame-session'
    ])
    expect(debuggerEvents.listenerCount('message')).toBe(0)
  })

  it.each([
    ['fill', (b: AgentBrowserBridge, text: string) => b.fill('@textarea', text)],
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

  it('sends option-like text on stdin so agent-browser cannot read it as a flag', async () => {
    succeedWith({ inserted: true })

    await bridge.keyboardInsertText('--help')

    expect(execFileMock.mock.calls.flatMap((call) => call[1])).not.toContain('--help')
    expect(agentBrowserCommandsIn(stdinWrites)).toEqual([['keyboard', 'inserttext', '--help']])
  })

  it('chunks large agent-browser keyboard insert text before transport', async () => {
    const text = ['z'.repeat(AGENT_BROWSER_TEXT_ARGUMENT_MAX_BYTES), 'qq'].join('')
    succeedWith({ inserted: true })

    await bridge.keyboardInsertText(text)

    const chunks = agentBrowserCommandsIn(stdinWrites)
      .filter(([name, subcommand]) => name === 'keyboard' && subcommand === 'inserttext')
      .map(([, , chunk]) => chunk)

    expect(chunks).toEqual(['z'.repeat(AGENT_BROWSER_TEXT_ARGUMENT_MAX_BYTES), 'qq'])
  })

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
        // Simulate the user viewing worktree B's tab, which sets the global target.
        b.onTabChanged(2, 'wt-2')
        succeedWith({ inserted: true })

        await expect(run(b)).rejects.toMatchObject({
          code: 'browser_target_ambiguous'
        })
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
      b.onTabChanged(2, 'wt-2')
      succeedWith({ snapshot: 'tree' })

      await b.snapshot(undefined, undefined)

      expect(sessionNamesUsed()).toContain('orca-tab-tab-b')
    })
  })
})
