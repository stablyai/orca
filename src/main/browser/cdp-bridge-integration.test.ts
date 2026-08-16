import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Electron mocks ──

const { webContentsFromIdMock } = vi.hoisted(() => ({
  webContentsFromIdMock: vi.fn()
}))

vi.mock('electron', () => ({
  webContents: { fromId: webContentsFromIdMock },
  shell: { openExternal: vi.fn() },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn(), on: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), isPackaged: false }
}))

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([]),
  listWorktreesStrict: vi.fn().mockResolvedValue([])
}))

import { BrowserManager } from './browser-manager'
import { BrowserError, CdpBridge } from './cdp-bridge'
import { BROWSER_TEXT_INSERT_CHUNK_BYTES } from './browser-text-insertion'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import { readRuntimeMetadata } from '../runtime/runtime-metadata'

// ── CDP response builders ──

type AXNode = {
  nodeId: string
  backendDOMNodeId?: number
  role?: { type: string; value: string }
  name?: { type: string; value: string }
  properties?: { name: string; value: { type: string; value: unknown } }[]
  childIds?: string[]
  ignored?: boolean
}

function axNode(
  id: string,
  role: string,
  name: string,
  opts?: { childIds?: string[]; backendDOMNodeId?: number }
): AXNode {
  return {
    nodeId: id,
    backendDOMNodeId: opts?.backendDOMNodeId ?? Number.parseInt(id, 10) * 100,
    role: { type: 'role', value: role },
    name: { type: 'computedString', value: name },
    childIds: opts?.childIds
  }
}

const EXAMPLE_COM_TREE: AXNode[] = [
  axNode('1', 'WebArea', 'Example Domain', { childIds: ['2', '3', '4'] }),
  axNode('2', 'heading', 'Example Domain'),
  axNode('3', 'staticText', 'This domain is for use in illustrative examples.'),
  axNode('4', 'link', 'More information...', { backendDOMNodeId: 400 })
]

const SEARCH_PAGE_TREE: AXNode[] = [
  axNode('1', 'WebArea', 'Search', { childIds: ['2', '3', '4', '5'] }),
  axNode('2', 'navigation', 'Main Nav', { childIds: ['3'] }),
  axNode('3', 'link', 'Home', { backendDOMNodeId: 300 }),
  axNode('4', 'textbox', 'Search query', { backendDOMNodeId: 400 }),
  axNode('5', 'button', 'Search', { backendDOMNodeId: 500 })
]

// ── Mock WebContents factory ──

function createMockGuest(
  id: number,
  url: string,
  title: string,
  options?: { readyState?: string | (() => string) }
) {
  let currentUrl = url
  let currentTitle = title
  let currentTree = EXAMPLE_COM_TREE
  let navHistoryId = 1
  let debuggerAttached = false

  const sendCommandMock = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    switch (method) {
      case 'Page.enable':
      case 'DOM.enable':
      case 'Accessibility.enable':
        return {}
      case 'Accessibility.getFullAXTree':
        return { nodes: currentTree }
      case 'Page.getNavigationHistory':
        return {
          entries: [{ id: navHistoryId, url: currentUrl }],
          currentIndex: 0
        }
      case 'Page.navigate': {
        const targetUrl = (params as { url: string }).url
        if (targetUrl.includes('nonexistent.invalid')) {
          return { errorText: 'net::ERR_NAME_NOT_RESOLVED' }
        }
        navHistoryId++
        currentUrl = targetUrl
        if (targetUrl.includes('search.example.com')) {
          currentTitle = 'Search'
          currentTree = SEARCH_PAGE_TREE
        } else {
          currentTitle = 'Example Domain'
          currentTree = EXAMPLE_COM_TREE
        }
        return {}
      }
      case 'Runtime.evaluate': {
        const expr = (params as { expression: string }).expression
        if (expr === 'document.readyState') {
          return {
            result: {
              value:
                typeof options?.readyState === 'function'
                  ? options.readyState()
                  : (options?.readyState ?? 'complete')
            }
          }
        }
        if (expr === 'location.origin') {
          return { result: { value: new URL(currentUrl).origin } }
        }
        if (expr.includes('innerWidth')) {
          return { result: { value: JSON.stringify({ w: 1280, h: 720 }) } }
        }
        if (expr.includes('scrollBy')) {
          return { result: { value: undefined } }
        }
        if (expr.includes('dispatchEvent')) {
          return { result: { value: undefined } }
        }
        // eslint-disable-next-line no-eval
        return { result: { value: String(eval(expr)), type: 'string' } }
      }
      case 'DOM.scrollIntoViewIfNeeded':
        return {}
      case 'DOM.getBoxModel':
        return { model: { content: [100, 200, 300, 200, 300, 250, 100, 250] } }
      case 'Input.dispatchMouseEvent':
        return {}
      case 'Input.insertText':
        return {}
      case 'Input.dispatchKeyEvent':
        return {}
      case 'DOM.focus':
        return {}
      case 'DOM.describeNode':
        return { node: { nodeId: 1 } }
      case 'DOM.requestNode':
        return { nodeId: 1 }
      case 'DOM.resolveNode':
        return { object: { objectId: 'obj-1' } }
      case 'Runtime.callFunctionOn':
        return { result: { value: undefined } }
      case 'DOM.setFileInputFiles':
        return {}
      case 'Page.captureScreenshot':
        return {
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
        }
      case 'Page.reload':
        return {}
      case 'Network.enable':
        return {}
      case 'Target.setAutoAttach':
        return {}
      case 'Page.addScriptToEvaluateOnNewDocument':
        return { identifier: 'mock-script-id' }
      case 'Runtime.enable':
        return {}
      default:
        throw new Error(`Unexpected CDP method: ${method}`)
    }
  })

  const debuggerListeners = new Map<string, ((...args: unknown[]) => void)[]>()

  const guest = {
    id,
    isDestroyed: vi.fn(() => false),
    getType: vi.fn(() => 'webview'),
    getURL: vi.fn(() => currentUrl),
    getTitle: vi.fn(() => currentTitle),
    setBackgroundThrottling: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    debugger: {
      isAttached: vi.fn(() => debuggerAttached),
      attach: vi.fn(() => {
        if (debuggerAttached) {
          throw new Error('Another debugger is already attached')
        }
        debuggerAttached = true
      }),
      detach: vi.fn(),
      sendCommand: sendCommandMock,
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        const handlers = debuggerListeners.get(event) ?? []
        handlers.push(handler)
        debuggerListeners.set(event, handlers)
      }),
      removeListener: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        const handlers = debuggerListeners.get(event) ?? []
        const idx = handlers.indexOf(handler)
        if (idx !== -1) {
          handlers.splice(idx, 1)
        }
      }),
      removeAllListeners: vi.fn((event: string) => {
        debuggerListeners.set(event, [])
      }),
      off: vi.fn()
    }
  }

  return {
    guest,
    sendCommandMock,
    emitDebugger(event: string, ...args: unknown[]) {
      for (const handler of debuggerListeners.get(event) ?? []) {
        handler(...args)
      }
    },
    emitDebuggerMessage(method: string, params?: Record<string, unknown>) {
      for (const handler of debuggerListeners.get('message') ?? []) {
        handler({}, method, params)
      }
    }
  }
}

// ── RPC helper ──

async function sendRequest(
  endpoint: string,
  request: Record<string, unknown>
): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(endpoint)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.once('error', reject)
    socket.on('data', (chunk: string) => {
      buffer += chunk
      const newlineIndex = buffer.indexOf('\n')
      if (newlineIndex === -1) {
        return
      }
      const message = buffer.slice(0, newlineIndex)
      socket.end()
      resolve(JSON.parse(message) as Record<string, unknown>)
    })
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(request)}\n`)
    })
  })
}

// ── Tests ──

describe('Browser automation pipeline (integration)', () => {
  let server: OrcaRuntimeRpcServer
  let endpoint: string
  let authToken: string
  let activeGuest: ReturnType<typeof createMockGuest>['guest']
  let activeGuestHarness: ReturnType<typeof createMockGuest>
  let cdpBridge: CdpBridge

  const GUEST_WC_ID = 5001
  const RENDERER_WC_ID = 1
  const PASSTHROUGH = Symbol('passthrough')

  beforeEach(async () => {
    activeGuestHarness = createMockGuest(GUEST_WC_ID, 'https://example.com', 'Example Domain')
    const { guest } = activeGuestHarness
    activeGuest = guest
    webContentsFromIdMock.mockImplementation((id: number) => {
      if (id === GUEST_WC_ID) {
        return guest
      }
      return null
    })

    const browserManager = new BrowserManager()
    // Simulate the attach-time policy (normally done in will-attach-webview)
    browserManager.attachGuestPolicies(guest as never)
    browserManager.registerGuest({
      browserPageId: 'page-1',
      webContentsId: GUEST_WC_ID,
      rendererWebContentsId: RENDERER_WC_ID
    })

    cdpBridge = new CdpBridge(browserManager)
    cdpBridge.setActiveTab(GUEST_WC_ID)

    const userDataPath = mkdtempSync(join(tmpdir(), 'browser-e2e-'))
    const runtime = new OrcaRuntimeService()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runtime.setAgentBrowserBridge(cdpBridge as any)

    server = new OrcaRuntimeRpcServer({ runtime, userDataPath })
    await server.start()

    const metadata = readRuntimeMetadata(userDataPath)!
    endpoint = metadata.transports[0]!.endpoint
    authToken = metadata.authToken!
  })

  afterEach(async () => {
    await server.stop()
  })

  async function rpc(method: string, params?: Record<string, unknown>) {
    const response = await sendRequest(endpoint, {
      id: `req_${method}`,
      authToken,
      method,
      ...(params ? { params } : {})
    })
    return response
  }

  function interceptCdp(
    handler: (method: string, params?: Record<string, unknown>) => unknown
  ): void {
    const sendCommand = activeGuestHarness.sendCommandMock as ReturnType<typeof vi.fn>
    const previous = sendCommand.getMockImplementation() as (
      method: string,
      params?: Record<string, unknown>
    ) => Promise<unknown>
    sendCommand.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      const result = handler(method, params)
      return result === PASSTHROUGH ? await previous(method, params) : result
    })
  }

  function evaluateInteractabilityCall(
    params: Record<string, unknown> | undefined,
    options?: {
      disabled?: boolean
      editable?: boolean
      readOnly?: boolean
      shadowRoot?: boolean
      obscured?: boolean
    }
  ): { result: { value: string } } {
    const declaration = String(params?.functionDeclaration)
    const compile = new Function('getComputedStyle', `return (${declaration})`)
    const check = compile(() => ({
      display: 'block',
      visibility: 'visible',
      pointerEvents: 'auto'
    })) as (this: Record<string, unknown>, ...args: unknown[]) => string
    const other = {}
    const target: Record<string, unknown> = {
      disabled: options?.disabled ?? false,
      inert: false,
      readOnly: options?.readOnly ?? false,
      hidden: false,
      type: options?.editable ? 'text' : 'button',
      tagName: options?.editable ? 'INPUT' : 'BUTTON',
      value: '',
      select: options?.editable ? () => undefined : undefined,
      isContentEditable: false,
      getAttribute: () => null,
      contains: () => false
    }
    const ownerDocument = {
      elementFromPoint: () => (options?.obscured ? other : target)
    }
    target.ownerDocument = ownerDocument
    target.getRootNode = () =>
      options?.shadowRoot ? { elementFromPoint: () => target } : ownerDocument
    const values = ((params?.arguments ?? []) as { value: unknown }[]).map(({ value }) => value)
    return { result: { value: check.call(target, ...values) } }
  }

  // ── Snapshot ──

  it('takes a snapshot and returns refs for interactive elements', async () => {
    const res = await rpc('browser.snapshot')
    expect(res.ok).toBe(true)

    const result = res.result as {
      snapshot: string
      refs: { ref: string; role: string; name: string }[]
      url: string
      title: string
    }
    expect(result.url).toBe('https://example.com')
    expect(result.title).toBe('Example Domain')
    expect(result.snapshot).toContain('heading "Example Domain"')
    expect(result.snapshot).toContain('link "More information..."')
    expect(result.refs).toHaveLength(1)
    expect(result.refs[0]).toMatchObject({
      ref: '@e1',
      role: 'link',
      name: 'More information...'
    })
    expect(activeGuest.debugger.attach).toHaveBeenCalledTimes(1)
  })

  it('preserves debugger listeners owned by other browser streams', async () => {
    const externalDetach = vi.fn()
    const externalMessage = vi.fn()
    activeGuest.debugger.on('detach', externalDetach)
    activeGuest.debugger.on('message', externalMessage)

    const res = await rpc('browser.snapshot')
    expect(res.ok).toBe(true)

    activeGuestHarness.emitDebugger('message', {}, 'Runtime.consoleAPICalled', {})
    activeGuestHarness.emitDebugger('detach')

    expect(externalMessage).toHaveBeenCalledWith({}, 'Runtime.consoleAPICalled', {})
    expect(externalDetach).toHaveBeenCalledTimes(1)
    expect(activeGuest.debugger.removeAllListeners).not.toHaveBeenCalled()
  })

  // ── Click ──

  it('clicks an element by ref after snapshot', async () => {
    await rpc('browser.snapshot')

    const res = await rpc('browser.click', { element: '@e1' })
    expect(res.ok).toBe(true)
    expect((res.result as { clicked: string }).clicked).toBe('@e1')
  })

  it('returns error when clicking without a prior snapshot', async () => {
    const res = await rpc('browser.click', { element: '@e1' })
    expect(res.ok).toBe(false)
    expect((res.error as { code: string }).code).toBe('browser_stale_ref')
  })

  it('returns error for non-existent ref', async () => {
    await rpc('browser.snapshot')

    const res = await rpc('browser.click', { element: '@e999' })
    expect(res.ok).toBe(false)
    expect((res.error as { code: string }).code).toBe('browser_ref_not_found')
  })

  it('classifies a missing layout box as browser_element_not_interactable', async () => {
    await rpc('browser.snapshot')
    interceptCdp((method) => {
      if (method === 'DOM.getBoxModel') {
        throw new Error('Could not compute box model.')
      }
      return PASSTHROUGH
    })

    const res = await rpc('browser.click', { element: '@e1' })

    expect(res.ok).toBe(false)
    expect((res.error as { code: string }).code).toBe('browser_element_not_interactable')
  })

  it('preserves CDP transport errors while reading the layout box', async () => {
    await rpc('browser.snapshot')
    interceptCdp((method) => {
      if (method === 'DOM.getBoxModel') {
        throw new BrowserError('browser_cdp_error', 'CDP transport failed')
      }
      return PASSTHROUGH
    })

    const res = await rpc('browser.click', { element: '@e1' })

    expect(res.ok).toBe(false)
    expect((res.error as { code: string }).code).toBe('browser_cdp_error')
  })

  it('does not misclassify unknown getBoxModel protocol errors', async () => {
    await rpc('browser.snapshot')
    interceptCdp((method) => {
      if (method === 'DOM.getBoxModel') {
        throw new Error('Could not find node with given id')
      }
      return PASSTHROUGH
    })

    const res = await rpc('browser.click', { element: '@e1' })

    expect(res.ok).toBe(false)
    expect((res.error as { code: string }).code).toBe('runtime_error')
  })

  it('rejects zero-size pointer targets', async () => {
    await rpc('browser.snapshot')
    interceptCdp((method) =>
      method === 'DOM.getBoxModel'
        ? { model: { content: [100, 200, 100, 200, 100, 250, 100, 250] } }
        : PASSTHROUGH
    )

    const res = await rpc('browser.click', { element: '@e1' })

    expect(res.ok).toBe(false)
    expect((res.error as { code: string }).code).toBe('browser_element_not_interactable')
  })

  it.each([
    ['browser.click', { element: '@e1' }],
    ['browser.check', { element: '@e1', checked: true }]
  ])('rejects disabled pointer targets for %s', async (method, params) => {
    await rpc('browser.snapshot')
    interceptCdp((cdpMethod, cdpParams) => {
      if (
        cdpMethod === 'Runtime.callFunctionOn' &&
        String(cdpParams?.functionDeclaration).includes('this.disabled')
      ) {
        return evaluateInteractabilityCall(cdpParams, { disabled: true })
      }
      return PASSTHROUGH
    })

    const res = await rpc(method, params)

    expect(res.ok).toBe(false)
    expect((res.error as { code: string }).code).toBe('browser_element_not_interactable')
  })

  it.each([
    ['browser.hover', { element: '@e1' }],
    ['browser.drag', { from: '@e1', to: '@e1' }]
  ])('allows disabled pointer targets for %s', async (method, params) => {
    await rpc('browser.snapshot')
    interceptCdp((cdpMethod, cdpParams) => {
      if (
        cdpMethod === 'Runtime.callFunctionOn' &&
        String(cdpParams?.functionDeclaration).includes('this.disabled')
      ) {
        return evaluateInteractabilityCall(cdpParams, { disabled: true })
      }
      return PASSTHROUGH
    })

    const res = await rpc(method, params)

    expect(res.ok).toBe(true)
    if (method === 'browser.drag') {
      const scrollCalls = activeGuestHarness.sendCommandMock.mock.calls.filter(
        ([name, args]) =>
          name === 'Runtime.callFunctionOn' &&
          String(args?.functionDeclaration).includes('scrollIntoView')
      )
      expect(scrollCalls).toHaveLength(2)
    }
  })

  it('rejects pointer targets obscured at their center', async () => {
    await rpc('browser.snapshot')
    interceptCdp((method, params) => {
      if (
        method === 'Runtime.callFunctionOn' &&
        String(params?.functionDeclaration).includes('elementFromPoint')
      ) {
        expect(((params?.arguments ?? []) as unknown[]).slice(0, 2)).toEqual([
          { value: 200 },
          { value: 225 }
        ])
        return evaluateInteractabilityCall(params, { obscured: true })
      }
      return PASSTHROUGH
    })

    const res = await rpc('browser.click', { element: '@e1' })

    expect(res.ok).toBe(false)
    expect((res.error as { code: string }).code).toBe('browser_element_not_interactable')
  })

  it('accepts a pointer target reached through its shadow root hit test', async () => {
    await rpc('browser.snapshot')
    interceptCdp((method, params) => {
      if (
        method !== 'Runtime.callFunctionOn' ||
        !String(params?.functionDeclaration).includes('elementFromPoint')
      ) {
        return PASSTHROUGH
      }
      return evaluateInteractabilityCall(params, { obscured: true, shadowRoot: true })
    })

    const res = await rpc('browser.click', { element: '@e1' })

    expect(res.ok).toBe(true)
  })

  // ── Navigation ──

  it('navigates to a URL and invalidates refs', async () => {
    await rpc('browser.snapshot')

    const gotoRes = await rpc('browser.goto', { url: 'https://search.example.com' })
    expect(gotoRes.ok).toBe(true)
    const gotoResult = gotoRes.result as { url: string; title: string }
    expect(gotoResult.url).toBe('https://search.example.com')
    expect(gotoResult.title).toBe('Search')

    // Old refs should be stale after navigation
    const clickRes = await rpc('browser.click', { element: '@e1' })
    expect(clickRes.ok).toBe(false)
    expect((clickRes.error as { code: string }).code).toBe('browser_stale_ref')

    // Re-snapshot should work and show new page
    const snapRes = await rpc('browser.snapshot')
    expect(snapRes.ok).toBe(true)
    const snapResult = snapRes.result as { snapshot: string; refs: { name: string }[] }
    expect(snapResult.snapshot).toContain('Search')
    expect(snapResult.refs.map((r) => r.name)).toContain('Search')
    expect(snapResult.refs.map((r) => r.name)).toContain('Home')
  })

  it('returns error for failed navigation', async () => {
    const res = await rpc('browser.goto', { url: 'https://nonexistent.invalid' })
    expect(res.ok).toBe(false)
    expect((res.error as { code: string }).code).toBe('browser_navigation_failed')
  })

  it('clears readyState polling timers when navigation times out', async () => {
    vi.useFakeTimers()
    try {
      const slowGuestHarness = createMockGuest(6001, 'https://slow.example.com', 'Slow Page', {
        readyState: 'loading'
      })
      webContentsFromIdMock.mockImplementation((id: number) => {
        if (id === 6001) {
          return slowGuestHarness.guest
        }
        return null
      })

      const browserManager = new BrowserManager()
      browserManager.attachGuestPolicies(slowGuestHarness.guest as never)
      browserManager.registerGuest({
        browserPageId: 'slow-page',
        webContentsId: 6001,
        rendererWebContentsId: RENDERER_WC_ID
      })
      const bridge = new CdpBridge(browserManager)
      bridge.setActiveTab(6001)

      const gotoResult = bridge.goto('https://slow.example.com/still-loading').then(
        () => null,
        (error: unknown) => error
      )

      await vi.advanceTimersByTimeAsync(25_000)

      await expect(gotoResult).resolves.toMatchObject({ code: 'browser_timeout' })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  // ── Fill ──

  it('fills an input by ref', async () => {
    await rpc('browser.goto', { url: 'https://search.example.com' })
    await rpc('browser.snapshot')
    interceptCdp((method, params) => {
      if (
        method === 'Runtime.callFunctionOn' &&
        String(params?.functionDeclaration).includes('this.disabled')
      ) {
        return evaluateInteractabilityCall(params, { editable: true })
      }
      return PASSTHROUGH
    })

    // @e2 should be the textbox "Search query" on the search page
    const res = await rpc('browser.fill', { element: '@e2', value: 'hello world' })
    expect(res.ok).toBe(true)
    expect((res.result as { filled: string }).filled).toBe('@e2')
  })

  it('rejects fill when the input has no layout box', async () => {
    await rpc('browser.goto', { url: 'https://search.example.com' })
    await rpc('browser.snapshot')
    interceptCdp((method) => {
      if (method === 'DOM.getBoxModel') {
        throw new Error('Could not compute box model.')
      }
      return PASSTHROUGH
    })

    const res = await rpc('browser.fill', { element: '@e2', value: 'hidden' })

    expect(res.ok).toBe(false)
    expect((res.error as { code: string }).code).toBe('browser_element_not_interactable')
  })

  it('rejects fill when the input is readonly', async () => {
    await rpc('browser.goto', { url: 'https://search.example.com' })
    await rpc('browser.snapshot')
    interceptCdp((method, params) => {
      if (
        method === 'Runtime.callFunctionOn' &&
        String(params?.functionDeclaration).includes('this.disabled')
      ) {
        return evaluateInteractabilityCall(params, { readOnly: true })
      }
      return PASSTHROUGH
    })

    const res = await rpc('browser.fill', { element: '@e2', value: 'readonly' })

    expect(res.ok).toBe(false)
    expect((res.error as { code: string }).code).toBe('browser_element_not_interactable')
  })

  it('rejects fill on a non-editable element', async () => {
    await rpc('browser.snapshot')
    interceptCdp((method, params) => {
      if (
        method === 'Runtime.callFunctionOn' &&
        String(params?.functionDeclaration).includes('this.disabled')
      ) {
        return evaluateInteractabilityCall(params)
      }
      return PASSTHROUGH
    })

    const res = await rpc('browser.fill', { element: '@e1', value: 'not editable' })

    expect(res.ok).toBe(false)
    expect((res.error as { code: string }).code).toBe('browser_element_not_interactable')
  })

  it('chunks large browser fill text before CDP insertText', async () => {
    await rpc('browser.goto', { url: 'https://search.example.com' })
    await rpc('browser.snapshot')

    const text = 'x'.repeat(BROWSER_TEXT_INSERT_CHUNK_BYTES + 5)
    const res = await rpc('browser.fill', { element: '@e2', value: text })

    const insertCalls = activeGuestHarness.sendCommandMock.mock.calls.filter(
      ([method]) => method === 'Input.insertText'
    )
    expect(res.ok).toBe(true)
    expect(insertCalls).toHaveLength(2)
    expect((insertCalls[0]![1] as { text: string }).text).toHaveLength(
      BROWSER_TEXT_INSERT_CHUNK_BYTES
    )
    expect((insertCalls[1]![1] as { text: string }).text).toBe('xxxxx')
  })

  // ── Type ──

  it('types text at current focus', async () => {
    const res = await rpc('browser.type', { input: 'some text' })
    expect(res.ok).toBe(true)
    expect((res.result as { typed: boolean }).typed).toBe(true)
  })

  it('chunks large browser type text before CDP insertText', async () => {
    const text = 'y'.repeat(BROWSER_TEXT_INSERT_CHUNK_BYTES + 2)
    const res = await rpc('browser.type', { input: text })

    const insertCalls = activeGuestHarness.sendCommandMock.mock.calls.filter(
      ([method]) => method === 'Input.insertText'
    )
    expect(res.ok).toBe(true)
    expect(insertCalls).toHaveLength(2)
    expect((insertCalls[0]![1] as { text: string }).text).toHaveLength(
      BROWSER_TEXT_INSERT_CHUNK_BYTES
    )
    expect((insertCalls[1]![1] as { text: string }).text).toBe('yy')
  })

  // ── Select ──

  it('selects a dropdown option by ref', async () => {
    await rpc('browser.goto', { url: 'https://search.example.com' })
    await rpc('browser.snapshot')

    const res = await rpc('browser.select', { element: '@e2', value: 'option-1' })
    expect(res.ok).toBe(true)
    expect((res.result as { selected: string }).selected).toBe('@e2')
  })

  // ── Scroll ──

  it('scrolls the viewport', async () => {
    const res = await rpc('browser.scroll', { direction: 'down' })
    expect(res.ok).toBe(true)
    expect((res.result as { scrolled: string }).scrolled).toBe('down')

    const res2 = await rpc('browser.scroll', { direction: 'up', amount: 200 })
    expect(res2.ok).toBe(true)
    expect((res2.result as { scrolled: string }).scrolled).toBe('up')
  })

  // ── Reload ──

  it('reloads the page', async () => {
    const res = await rpc('browser.reload')
    expect(res.ok).toBe(true)
    expect((res.result as { url: string }).url).toBe('https://example.com')
  })

  // ── Screenshot ──

  it('captures a screenshot', async () => {
    const res = await rpc('browser.screenshot', { format: 'png' })
    expect(res.ok).toBe(true)
    const result = res.result as { data: string; format: string }
    expect(result.format).toBe('png')
    expect(result.data.length).toBeGreaterThan(0)
  })

  it('bounds capture request bookkeeping when network entries are evicted or fail', async () => {
    const startRes = await rpc('browser.capture.start')
    expect(startRes.ok).toBe(true)

    for (let i = 0; i <= 1000; i++) {
      activeGuestHarness.emitDebuggerMessage('Network.responseReceived', {
        requestId: `req-${i}`,
        response: {
          url: `https://example.com/${i}`,
          status: 200,
          mimeType: 'text/plain'
        },
        timestamp: i
      })
    }

    const state = (
      cdpBridge as unknown as {
        tabState: Map<
          string,
          {
            networkLog: unknown[]
            networkRequestMap: Map<string, unknown>
          }
        >
      }
    ).tabState.get('page-1')

    expect(state?.networkLog).toHaveLength(1000)
    expect(state?.networkRequestMap.has('req-0')).toBe(false)
    expect(state?.networkRequestMap.size).toBe(1000)

    activeGuestHarness.emitDebuggerMessage('Network.loadingFailed', { requestId: 'req-1' })
    expect(state?.networkRequestMap.has('req-1')).toBe(false)
    expect(state?.networkRequestMap.size).toBe(999)

    const stopRes = await rpc('browser.capture.stop')
    expect(stopRes.ok).toBe(true)
    expect(state?.networkRequestMap.size).toBe(0)
  })

  // ── Eval ──

  it('evaluates JavaScript in the page context', async () => {
    const res = await rpc('browser.eval', { expression: '2 + 2' })
    expect(res.ok).toBe(true)
    expect((res.result as { result: string }).result).toBe('4')
  })

  // ── Tab management ──

  it('lists open tabs', async () => {
    const res = await rpc('browser.tabList')
    expect(res.ok).toBe(true)
    const result = res.result as { tabs: { index: number; url: string; active: boolean }[] }
    expect(result.tabs).toHaveLength(1)
    expect(result.tabs[0]).toMatchObject({
      index: 0,
      url: 'https://example.com',
      active: true
    })
  })

  it('returns error for out-of-range tab switch', async () => {
    const res = await rpc('browser.tabSwitch', { index: 5 })
    expect(res.ok).toBe(false)
    expect((res.error as { code: string }).code).toBe('browser_tab_not_found')
  })

  // ── Full agent workflow simulation ──

  it('simulates a complete agent workflow: navigate → snapshot → interact → re-snapshot', async () => {
    // 1. Navigate to search page
    const gotoRes = await rpc('browser.goto', { url: 'https://search.example.com' })
    expect(gotoRes.ok).toBe(true)

    // 2. Snapshot the page
    const snap1 = await rpc('browser.snapshot')
    expect(snap1.ok).toBe(true)
    const snap1Result = snap1.result as {
      snapshot: string
      refs: { ref: string; role: string; name: string }[]
    }

    // Verify we see the search page structure
    expect(snap1Result.snapshot).toContain('[Main Nav]')
    expect(snap1Result.snapshot).toContain('text input "Search query"')
    expect(snap1Result.snapshot).toContain('button "Search"')

    // 3. Fill the search input
    const searchInput = snap1Result.refs.find((r) => r.name === 'Search query')
    expect(searchInput).toBeDefined()
    const fillRes = await rpc('browser.fill', {
      element: searchInput!.ref,
      value: 'integration testing'
    })
    expect(fillRes.ok).toBe(true)

    // 4. Click the search button
    const searchBtn = snap1Result.refs.find((r) => r.name === 'Search')
    expect(searchBtn).toBeDefined()
    const clickRes = await rpc('browser.click', { element: searchBtn!.ref })
    expect(clickRes.ok).toBe(true)

    // 5. Take a screenshot
    const ssRes = await rpc('browser.screenshot')
    expect(ssRes.ok).toBe(true)

    // 6. Check tab list
    const tabRes = await rpc('browser.tabList')
    expect(tabRes.ok).toBe(true)
    const tabs = (tabRes.result as { tabs: { url: string }[] }).tabs
    expect(tabs[0].url).toBe('https://search.example.com')
  })

  // ── No tab errors ──

  it('returns browser_no_tab when no tabs are registered', async () => {
    // Create a fresh setup with no registered tabs
    const emptyManager = new BrowserManager()
    const emptyBridge = new CdpBridge(emptyManager)

    const userDataPath2 = mkdtempSync(join(tmpdir(), 'browser-e2e-empty-'))
    const runtime2 = new OrcaRuntimeService()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runtime2.setAgentBrowserBridge(emptyBridge as any)

    const server2 = new OrcaRuntimeRpcServer({ runtime: runtime2, userDataPath: userDataPath2 })
    await server2.start()

    const metadata2 = readRuntimeMetadata(userDataPath2)!
    const res = await sendRequest(metadata2.transports[0]!.endpoint, {
      id: 'req_no_tab',
      authToken: metadata2.authToken,
      method: 'browser.snapshot'
    })

    expect(res.ok).toBe(false)
    expect((res.error as { code: string }).code).toBe('browser_no_tab')

    await server2.stop()
  })
})
