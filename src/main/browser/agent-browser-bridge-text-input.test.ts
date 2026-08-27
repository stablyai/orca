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
import {
  CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS,
  CLIPBOARD_TEXT_WRITE_MAX_BYTES,
  CLIPBOARD_TEXT_WRITE_TOO_LARGE_ERROR
} from '../../shared/clipboard-text'
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

function succeedForContentEditable(data: unknown = { ok: true }): void {
  execFileMock.mockImplementation(
    (_bin: string, args: string[], _opts: unknown, cb: ExecFileCallback) => {
      const result =
        args.includes('get') && args.includes('attr') && args.includes('contenteditable')
          ? { value: 'true' }
          : data
      cb(null, JSON.stringify({ success: true, data: result }), '')
      return {
        stdin: { on: vi.fn(), end: (text: string) => stdinWrites.push(text) }
      }
    }
  )
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
})
