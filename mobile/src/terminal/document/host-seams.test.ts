// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTerminalDocumentScope, type TerminalDocumentScope } from './document-scope'
import { startTerminalDocument, stopTerminalDocument } from './create-terminal-document'
import { handleMsg } from './host-message-router'
import { notify } from './host-notify'
import { flog } from './viewport-transform'
import { attachWebglAddon } from './webgl-recovery'
import type { TerminalDocumentHost, TerminalViewportChange } from './document-host-seams'
import { documentSourceText } from './document-module-source.test-support'

/**
 * The host seams the page sets, and the window reads and writes they default to.
 *
 * The document reached its host through `window.ReactNativeWebView` and built its engine from
 * `window.Terminal` and the two addon globals the engine bundle installs. On the page neither is
 * available the way the document assumes: `window.ReactNativeWebView` is the *shell's* bridge, so
 * a terminal notify posted through it would put raw terminal JSON into the bridge's own channel,
 * and there is no engine bundle at all because the page imports xterm as a module.
 *
 * So each is a scope field. The default is the window read the document already did,
 * unchanged and still performed at call time rather than captured when the scope is built; the
 * page assigns the field instead. Both halves are asserted here, because a seam whose default
 * quietly stopped reading the window would leave the native document mute with every other
 * terminal test still green — they stub those globals and would be stubbing nothing.
 */

const SURFACE_MARKUP =
  '<div id="terminal-container"><div id="terminal-surface"></div></div>' +
  '<div id="selection-overlay"><div id="sel-handle-start"></div>' +
  '<div id="sel-handle-end"></div><div id="sel-menu">' +
  '<button id="sel-menu-copy"></button><button id="sel-menu-all"></button></div></div>' +
  '<div id="scroll-indicator"><div id="scroll-thumb"></div></div>'

/**
 * Every document a case started, so `afterEach` can stop them.
 *
 * A start installs six listeners on `document` and `window` — the dispatcher's four capture-phase
 * touch handlers, the fit's resize and the recovery's visibilitychange — and they are page-wide by
 * nature, so a document nobody stopped keeps answering events in the next case with a scope that
 * case knows nothing about, and calls that case's host hooks.
 */
const startedScopes: TerminalDocumentScope[] = []

/**
 * A started document over a scope the case owns, with the hooks it wants as the host argument.
 *
 * The whole sequence, not a hand-picked subset: the elements `surface-swap`, `text-scaling` and
 * `selection-state-and-eviction` read are read in the one order both hosts run them in, and a
 * module added to that sequence is covered here without this file being edited.
 */
function startedScope(host: TerminalDocumentHost = {}): TerminalDocumentScope {
  document.body.innerHTML = SURFACE_MARKUP
  // The two the sequence itself would otherwise answer with the window: a transport that installs
  // nothing, because these cases are not the shell's, and an engine that is here, because a case
  // that has not stubbed `window.Terminal` is not testing readiness.
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
  // Before the globals go back: a stop reads the scope's own seams, and one of them is a window
  // read a case may have stubbed.
  while (startedScopes.length > 0) {
    stopTerminalDocument(startedScopes.pop()!)
  }
  vi.unstubAllGlobals()
})

describe('the document host seams, by default', () => {
  it('posts to the React Native bridge, reading it at call time', () => {
    const postMessage = vi.fn<(data: string) => void>()
    // Built before the global exists: the default must read the window when it posts, not when
    // the scope was created, because the document's scope is built as its script is parsed.
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
      // Ruling 20 made the install a per-mount act, so the seam owes the caller a way back.
      uninstall()
      expect(window.onerror).toBe(null)
    } finally {
      window.onerror = previous
    }
  })

  it('paints the document roots, which is what owning the page means', () => {
    // Inside the WebView the terminal's theme is the page's own background, so the document sets
    // it on `html` and `body`. On the page those belong to the application, which is why this is
    // a field: the render check holds that neither root moves while a terminal is mounted.
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
  it('fits a measure with no container height to the host rather than the window', () => {
    // The page's host is one element on a page that is taller and wider than it; the window is
    // happy-dom's 1024x768, so a fit read off the window would answer 136x51.
    const cell = { width: 7.5, height: 15 }
    const terminal = Object.assign(terminalDouble(), {
      _core: { _renderService: { dimensions: { css: { cell } } } }
    })
    const posted: Record<string, unknown>[] = []
    const scope = startedScope({
      createTerminal: () => terminal,
      postToHost: (message) => posted.push(message),
      viewportRect: () => ({ left: 0, top: 82, width: 390, height: 600 })
    })
    handleMsg(scope, { type: 'init', cols: 80, rows: 24, initialData: '', preserveScroll: false })
    handleMsg(scope, { type: 'measure' })
    expect(posted.filter((message) => message.type === 'measure-result')).toEqual([
      { type: 'measure-result', cols: 52, rows: 40 }
    ])
  })

  it('routes every notify to the field and nothing to the bridge', () => {
    const postMessage = vi.fn<(data: string) => void>()
    vi.stubGlobal('ReactNativeWebView', { postMessage })
    const posted: Record<string, unknown>[] = []
    const scope = startedScope({ postToHost: (message) => posted.push(message) })
    // The sequence's own `web-ready` is the document reporting itself started; what this case reads
    // is what the two notify paths send afterwards.
    expect(posted).toEqual([{ type: 'web-ready' }])
    posted.length = 0
    notify(scope, { type: 'pong', pingId: 7 })
    flog(scope, 'probe', { n: 1 })
    expect(posted).toEqual([
      { type: 'pong', pingId: 7 },
      { type: 'log', tag: '[fit]probe', payload: { n: 1 } }
    ])
    // The whole reason the seam exists: on the page this object belongs to the shell.
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
    // The other direction: a document-side report reaches the page's sink, not the bridge.
    handleMsg(scope, { type: 'ping', id: 3 })
    expect(posted).toContainEqual({ type: 'pong', pingId: 3 })
  })

  it('leaves window.onerror alone when the host installs the reporter its own way', () => {
    // The page's case, which is the whole reason this one is a field: on a page that object is
    // not the terminal's to take. A host that installs its reporter elsewhere must leave it null.
    const previous = window.onerror
    window.onerror = null
    const installed: unknown[] = []
    try {
      const built = createTerminalDocumentScope()
      const undos: unknown[] = []
      built.installErrorReporter = (report) => {
        installed.push(report)
        return () => undos.push(report)
      }
      built.installErrorReporter(() => {})()
      expect(installed).toHaveLength(1)
      expect(undos).toHaveLength(1)
      expect(window.onerror).toBe(null)
    } finally {
      window.onerror = previous
    }
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
    // The same box shown again with no fit held is not a resize: the pan stays.
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

  it('is read through the seam everywhere, never off the window directly', () => {
    // The default in `document-host-seams.ts` is the one window read, so the census runs over
    // every other module; a raw read elsewhere sizes a page terminal to the whole page.
    const raw = documentSourceText()
      .split('\n')
      .filter((line) => /window\.inner(Height|Width)|\binner(Height|Width)\b/.test(line))
    expect(raw).toEqual([
      '  return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }'
    ])
  })

  it('maps a client point into the grid only through viewportPoint', () => {
    // On the page the host's origin is not the window's, so a client coordinate used against
    // anything but another client coordinate lands rows low. Differences of two need no origin.
    const arithmetic = documentSourceText()
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/)/.test(line))
      .filter((line) => /client[XY]\s*[-+*/<>]|[-+*/<>]=?\s*[\w.[\]]*client[XY]\b/.test(line))
      .map((line) => line.trim())
      .sort()
    expect(arithmetic).toEqual([
      'const dx = Math.abs(e.clientX - gesture.startX)',
      'const dx = Math.abs(mt.clientX - scope.tapCandidate.x)',
      'const dx = Math.abs(t.clientX - scope.longPressOrigin.x)',
      'const dx = a.clientX - b.clientX,',
      'const dy = Math.abs(e.clientY - gesture.startY)',
      'const dy = Math.abs(mt.clientY - scope.tapCandidate.y)',
      'const dy = Math.abs(t.clientY - scope.longPressOrigin.y)',
      'dy = a.clientY - b.clientY',
      'return viewportPoint(scope, (a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2)',
      'return { x: clientX - frame.left, y: clientY - frame.top }'
    ])
  })
})
