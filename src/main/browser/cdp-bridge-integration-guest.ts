import { createConnection } from 'node:net'
import { vi, type Mock } from 'vitest'

type DebuggerListener = (...args: unknown[]) => void

// Why: annotate the export so composite tsc does not leak @vitest/spy Procedure (TS2883).
export type MockBrowserGuestHarness = {
  guest: {
    id: number
    isDestroyed: Mock<() => boolean>
    getType: Mock<() => string>
    getURL: Mock<() => string>
    getTitle: Mock<() => string>
    setBackgroundThrottling: Mock<(value: boolean) => void>
    setWindowOpenHandler: Mock<(handler: unknown) => void>
    on: Mock<(event: string, handler: DebuggerListener) => void>
    off: Mock<(event: string, handler: DebuggerListener) => void>
    debugger: {
      isAttached: Mock<() => boolean>
      attach: Mock<() => void>
      detach: Mock<() => void>
      sendCommand: Mock<
        (method?: string, params?: Record<string, unknown>, sessionId?: string) => Promise<unknown>
      >
      on: Mock<(event: string, handler: DebuggerListener) => void>
      removeListener: Mock<(event: string, handler: DebuggerListener) => void>
      removeAllListeners: Mock<(event?: string) => void>
      off: Mock<(event: string, handler: DebuggerListener) => void>
    }
  }
  sendCommandMock: MockBrowserGuestHarness['guest']['debugger']['sendCommand']
  emitDebugger(event: string, ...args: unknown[]): void
  emitDebuggerMessage(method: string, params?: Record<string, unknown>): void
}

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

export function createMockGuest(
  id: number,
  url: string,
  title: string,
  options?: { readyState?: string | (() => string) }
): MockBrowserGuestHarness {
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
  } as MockBrowserGuestHarness
}

export async function sendBrowserRpcRequest(
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
