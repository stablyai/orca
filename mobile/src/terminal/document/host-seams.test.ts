// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTerminalDocumentScope, type TerminalDocumentScope } from './document-scope'
import { startTerminalDocument, stopTerminalDocument } from './create-terminal-document'
import { handleMsg } from './host-message-router'
import { notify } from './host-notify'
import { flog } from './viewport-transform'
import { attachWebglAddon } from './webgl-recovery'
import type { TerminalDocumentHost, TerminalViewportChange } from './document-host-seams'

// Check native defaults and mount overrides: embedded terminals must not use the shell’s bridge or rely on engine globals.

const SURFACE_MARKUP =
  '<div id="terminal-container"><div id="terminal-surface"></div></div>' +
  '<div id="selection-overlay"><div id="sel-handle-start"></div>' +
  '<div id="sel-handle-end"></div><div id="sel-menu">' +
  '<button id="sel-menu-copy"></button><button id="sel-menu-all"></button></div></div>' +
  '<div id="scroll-indicator"><div id="scroll-thumb"></div></div>'

// Stop all started documents; their page-wide listeners would otherwise act on later tests.
const startedScopes: TerminalDocumentScope[] = []

// Use the real lifecycle sequence so new modules participate without this test restating startup order.
function startedScope(host: TerminalDocumentHost = {}): TerminalDocumentScope {
  document.body.innerHTML = SURFACE_MARKUP
  const scope = createTerminalDocumentScope({
    installHostTransport: () => () => {},
    hasEngine: () => true,
    ...host
  })
  startTerminalDocument(scope)
  startedScopes.push(scope)
  return scope
}

function terminalDouble() {
  const loaded: unknown[] = []
  let opened: HTMLElement | undefined
  const terminal = {
    cols: 80,
    rows: 24,
    options: { theme: {}, minimumContrastRatio: 3, fontSize: 13 },
    buffer: {
      active: {
        baseY: 0,
        viewportY: 0,
        cursorY: 0,
        length: 1,
        type: 'normal',
        getLine: () => undefined
      }
    },
    get element() {
      return opened
    },
    unicode: { activeVersion: '6' },
    loaded,
    write(_data: string, callback?: () => void) {
      callback?.()
    },
    open(element: HTMLElement) {
      opened = element
    },
    loadAddon: (addon: unknown) => loaded.push(addon),
    attachCustomKeyEventHandler() {},
    onData: () => ({ dispose() {} }),
    onLineFeed: () => ({ dispose() {} }),
    onScroll: () => ({ dispose() {} }),
    onWriteParsed: () => ({ dispose() {} }),
    clear() {},
    reset() {},
    refresh() {},
    resize() {},
    selectAll() {},
    select() {},
    clearSelection() {},
    scrollLines() {},
    scrollToLine() {},
    scrollToBottom() {},
    dispose() {}
  }
  return terminal
}

afterEach(() => {
  // Stop before restoring globals because seam cleanup can still read stubbed window state.
  while (startedScopes.length > 0) {
    stopTerminalDocument(startedScopes.pop()!)
  }
  vi.unstubAllGlobals()
})

describe('the document host seams, by default', () => {
  it('posts to the React Native bridge, reading it at call time', () => {
    const postMessage = vi.fn<(data: string) => void>()
    // Read the bridge at post time; scope construction may precede global installation.
    const built = createTerminalDocumentScope()
    vi.stubGlobal('ReactNativeWebView', { postMessage })
    built.postToHost({ type: 'ready', cols: 80, rows: 24 })
    expect(postMessage.mock.calls).toEqual([['{"type":"ready","cols":80,"rows":24}']])
  })

  it('posts nothing when there is no bridge, which is the guard the document carried', () => {
    expect(() => createTerminalDocumentScope().postToHost({ type: 'ready' })).not.toThrow()
  })

  it('builds the terminal from the engine bundle global', () => {
    const constructed: Record<string, unknown>[] = []
    function TerminalStub(this: unknown, options: Record<string, unknown>) {
      constructed.push(options)
    }
    vi.stubGlobal('Terminal', TerminalStub)
    const term = createTerminalDocumentScope().createTerminal({ cols: 80, rows: 24 })
    expect(constructed).toEqual([{ cols: 80, rows: 24 }])
    expect(term).toBeInstanceOf(TerminalStub)
  })

  it('installs the runtime error reporter by taking window.onerror, and hands back its undo', () => {
    const previous = window.onerror
    try {
      const report = () => {}
      const uninstall = createTerminalDocumentScope().installErrorReporter(report)
      expect(window.onerror).toBe(report)
      uninstall()
      expect(window.onerror).toBe(null)
    } finally {
      window.onerror = previous
    }
  })

  it('paints the document roots, which is what owning the page means', () => {
    // Native terminal themes may paint document roots; embedded mounts must leave the app’s roots unchanged.
    const roots = [document.documentElement, document.body]
    const previous = roots.map((element) => element.style.background)
    try {
      createTerminalDocumentScope().paintDocumentBackground('rgb(1, 2, 3)')
      expect(roots.map((element) => element.style.background)).toEqual([
        'rgb(1, 2, 3)',
        'rgb(1, 2, 3)'
      ])
    } finally {
      roots.forEach((element, index) => {
        element.style.background = previous[index]!
      })
    }
  })

  it('builds each addon from its engine global, and answers null when the engine has none', () => {
    const built = createTerminalDocumentScope()
    expect(built.createUnicode11Addon()).toBe(null)
    expect(built.createWebglAddon()).toBe(null)
    class Unicode11Addon {
      dispose() {}
    }
    class WebglAddon {
      dispose() {}
    }
    vi.stubGlobal('Unicode11Addon', { Unicode11Addon })
    vi.stubGlobal('WebglAddon', { WebglAddon })
    expect(built.createUnicode11Addon()).toBeInstanceOf(Unicode11Addon)
    expect(built.createWebglAddon()).toBeInstanceOf(WebglAddon)
  })
  it('frames the viewport as the window, read at call time', () => {
    const scope = createTerminalDocumentScope()
    vi.stubGlobal('innerWidth', 381)
    vi.stubGlobal('innerHeight', 612)
    expect(scope.viewportRect()).toEqual({ left: 0, top: 0, width: 381, height: 612 })
  })
})

describe('the document host seams, once the page sets them', () => {
  it('keeps the frame React Native laid out from each grid, not the viewport CSS rounded', () => {
    const frame = { width: 1080 / 2.75, height: 600 }
    const scope = startedScope({
      createTerminal: () => terminalDouble(),
      viewportRect: () => ({ left: 0, top: 0, width: 393, height: 600 })
    })
    handleMsg(scope, { type: 'init', cols: 80, rows: 24, initialData: '', preserveScroll: false })
    expect(scope.hostFrame).toBeNull()
    handleMsg(scope, { type: 'resize', cols: 50, rows: 40, frame: { width: 390, height: 0 } })
    expect(scope.hostFrame).toBeNull()
    handleMsg(scope, { type: 'resize', cols: 50, rows: 40, frame })
    expect(scope.hostFrame).toEqual(frame)
    handleMsg(scope, { type: 'reflow', cols: 50, rows: 40 })
    expect(scope.hostFrame).toEqual(frame)
  })

  it('routes every notify to the field and nothing to the bridge', () => {
    const postMessage = vi.fn<(data: string) => void>()
    vi.stubGlobal('ReactNativeWebView', { postMessage })
    const posted: Record<string, unknown>[] = []
    const scope = startedScope({ postToHost: (message) => posted.push(message) })
    expect(posted).toEqual([expect.objectContaining({ type: 'web-ready' })])
    posted.length = 0
    notify(scope, { type: 'pong', pingId: 7 })
    flog(scope, 'probe', { n: 1 })
    expect(posted).toEqual([
      { type: 'pong', pingId: 7 },
      { type: 'log', tag: '[fit]probe', payload: { n: 1 } }
    ])
    expect(postMessage).not.toHaveBeenCalled()
  })

  it('routes a host message into the document and builds the engine from the fields', () => {
    const terminal = terminalDouble()
    const options: Record<string, unknown>[] = []
    const unicodeAddon = { dispose() {} }
    const webglAddon = { dispose() {} }
    const posted: Record<string, unknown>[] = []
    const scope = startedScope({
      createTerminal: (created) => {
        options.push(created)
        return terminal
      },
      createUnicode11Addon: () => unicodeAddon,
      createWebglAddon: () => webglAddon,
      postToHost: (message) => posted.push(message)
    })
    handleMsg(scope, { type: 'init', cols: 80, rows: 24, initialData: '', preserveScroll: false })
    expect(options).toHaveLength(1)
    expect(options[0]!.cols).toBe(80)
    expect(terminal.loaded).toContain(webglAddon)
    expect(terminal.loaded).toContain(unicodeAddon)
    expect(terminal.unicode.activeVersion).toBe('11')
    handleMsg(scope, { type: 'ping', id: 3 })
    expect(posted).toContainEqual({ type: 'pong', pingId: 3 })
  })

  it('reports no webgl addon as a DOM-renderer fallback rather than as a failure', () => {
    expect(attachWebglAddon(startedScope({ createWebglAddon: () => null }), true)).toBe(false)
  })
})

describe("the document's viewport", () => {
  it('refits when the host says its box changed, and not on a window resize it does not own', () => {
    const changes: ((change: TerminalViewportChange) => void)[] = []
    const scope = startedScope({
      createTerminal: () => terminalDouble(),
      observeViewport: (onChange) => {
        changes.push(onChange)
        return () => {}
      }
    })
    handleMsg(scope, { type: 'init', cols: 80, rows: 24, initialData: '', preserveScroll: false })
    scope.panX = 50
    window.dispatchEvent(new Event('resize'))
    expect(scope.panX).toBe(50)
    expect(changes).toHaveLength(1)
    changes[0]!('shown')
    expect(scope.panX).toBe(50)
    changes[0]!('resized')
    expect(scope.panX).toBe(0)
  })

  it('refits on a window resize by default, where the window is the frame', () => {
    const scope = startedScope({ createTerminal: () => terminalDouble() })
    handleMsg(scope, { type: 'init', cols: 80, rows: 24, initialData: '', preserveScroll: false })
    scope.panX = 50
    window.dispatchEvent(new Event('resize'))
    expect(scope.panX).toBe(0)
  })
})
