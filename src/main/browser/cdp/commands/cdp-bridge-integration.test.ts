import type * as WorktreeScanCacheModule from '../../../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListingModule from '../../../git/worktrees/catalog/worktree-listing'
import { mkdtempSync } from 'node:fs'
import { RuntimeBrowserCommands } from '../../../runtime/browser/commands/browser-commands'
import { setRuntimeBrowserCommandsFactory } from '../../../runtime/browser/installation/runtime-browser-commands-factory'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserManager } from '../../guest-lifecycle/manager/browser-manager'
import { CdpBridge } from './cdp-bridge'
import { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { OrcaRuntimeRpcServer } from '../../../runtime/rpc/server/runtime-rpc'
import { readRuntimeMetadata } from '../../../runtime/rpc/server/runtime-metadata'

const { webContentsFromIdMock } = vi.hoisted(() => ({
  webContentsFromIdMock: vi.fn()
}))

vi.mock('../../../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => {
  const facade = getWorktreeListingMocks()
  return {
    ...(await importOriginal<typeof WorktreeScanCacheModule>()),
    listWorktrees: facade.listWorktrees
  }
})

vi.mock('../../../git/worktrees/catalog/worktree-listing', async (importOriginal) => {
  const facade = getWorktreeListingMocks()
  return {
    ...(await importOriginal<typeof WorktreeListingModule>()),
    listWorktreesStrict: facade.listWorktreesStrict
  }
})

vi.mock('electron', () => ({
  webContents: { fromId: webContentsFromIdMock },
  shell: { openExternal: vi.fn() },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn(), on: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), isPackaged: false }
}))

const { getWorktreeListingMocks } = vi.hoisted(() => {
  const createWorktreeListingMocks = () => ({
    listWorktrees: vi.fn().mockResolvedValue([]),
    listWorktreesStrict: vi.fn().mockResolvedValue([])
  })
  let listings: ReturnType<typeof createWorktreeListingMocks> | undefined
  return { getWorktreeListingMocks: () => (listings ??= createWorktreeListingMocks()) }
})

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
    isCurrentlyAudible: vi.fn(() => false),
    setIgnoreMenuShortcuts: vi.fn(),
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
    setTree(tree: AXNode[]) {
      currentTree = tree
    },
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

describe('Browser automation pipeline (integration)', () => {
  let server: OrcaRuntimeRpcServer
  let endpoint: string
  let authToken: string
  let activeGuestHarness: ReturnType<typeof createMockGuest>
  let cdpBridge: CdpBridge

  const GUEST_WC_ID = 5001
  const RENDERER_WC_ID = 1

  beforeEach(async () => {
    // The Electron entry installs this factory; Node hosts omit browser commands.
    setRuntimeBrowserCommandsFactory((host) => new RuntimeBrowserCommands(host))
    activeGuestHarness = createMockGuest(GUEST_WC_ID, 'https://example.com', 'Example Domain')
    const { guest } = activeGuestHarness
    webContentsFromIdMock.mockImplementation((id: number) => {
      if (id === GUEST_WC_ID) {
        return guest
      }
      return null
    })

    const browserManager = new BrowserManager()
    // Production applies these policies in will-attach-webview.
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

  it('navigates to a URL and invalidates refs', async () => {
    await rpc('browser.snapshot')

    const gotoRes = await rpc('browser.goto', { url: 'https://search.example.com' })
    expect(gotoRes.ok).toBe(true)
    const gotoResult = gotoRes.result as { url: string; title: string }
    expect(gotoResult.url).toBe('https://search.example.com')
    expect(gotoResult.title).toBe('Search')

    const clickRes = await rpc('browser.click', { element: '@e1' })
    expect(clickRes.ok).toBe(false)
    expect((clickRes.error as { code: string }).code).toBe('browser_stale_ref')

    const snapRes = await rpc('browser.snapshot')
    expect(snapRes.ok).toBe(true)
    const snapResult = snapRes.result as { snapshot: string; refs: { name: string }[] }
    expect(snapResult.snapshot).toContain('Search')
    expect(snapResult.refs.map((r) => r.name)).toContain('Search')
    expect(snapResult.refs.map((r) => r.name)).toContain('Home')
  })
})
