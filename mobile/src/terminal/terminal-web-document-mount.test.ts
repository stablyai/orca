// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { terminalDocumentDouble } from './document/document-terminal-double.test-support'
import type { TerminalDocumentTerminal } from './document/document-terminal-shape'
import type { TerminalWebViewCommand } from './terminal-webview-messages'
import type { TerminalWebViewHandle } from './terminal-webview-contract'
import { TerminalPaneView } from '../session/TerminalPaneView'
import { TERMINAL_DOCUMENT_MARKUP } from './terminal-webview-html'
import terminalNerdFontUrl from '../../assets/fonts/SymbolsNerdFontMono-Regular.woff2'

// Use the real factory to test partial swaps, startup failure and its error report without replacing the document under test.
let startThrows: Error | null = null
const startedScales: number[] = []
const startedBuilds: boolean[] = []
let gridTerminal: (() => TerminalDocumentTerminal) | null = null

vi.mock('./document/create-terminal-document', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./document/create-terminal-document')>()
  return {
    ...actual,
    createTerminalDocument: (host: Parameters<typeof actual.createTerminalDocument>[0]) => {
      startedScales.push(host?.start?.().textScale ?? 1)
      startedBuilds.push(host?.start?.().shown ?? true)
      if (startThrows) {
        throw startThrows
      }
      const grid = gridTerminal
      return actual.createTerminalDocument(grid ? { ...host, createTerminal: grid } : host)
    }
  }
})

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
  AppState: { addEventListener: () => ({ remove() {} }) }
}))
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react')
  return { useFocusEffect: (effect: () => () => void) => useEffect(effect, [effect]) }
})
vi.mock('lucide-react-native', () => ({ RefreshCw: 'Icon' }))
vi.mock('./TerminalWebView', () => import('./TerminalWebView.web'))

const { createTerminalDocument } = await import('./document/create-terminal-document')
const { mountTerminalWebDocument } = await import('./terminal-web-document-mount')
const { TerminalWebView } = await import('./TerminalWebView.web')

const HOST_CLASS = 'orca-terminal-document-host'

function plantHost() {
  const host = document.createElement('div')
  host.innerHTML = TERMINAL_DOCUMENT_MARKUP
  document.body.appendChild(host)
  return host
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

const INIT = { type: 'init', cols: 80, rows: 24, initialData: '', preserveScroll: false } as const

let renderer: ReactTestRenderer | null = null
let restoreTransform: (() => void) | null = null

beforeEach(() => {
  startThrows = null
  startedScales.length = 0
  startedBuilds.length = 0
  gridTerminal = null
  document.body.innerHTML = ''
  document.head.innerHTML = ''
})

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  restoreTransform?.()
  restoreTransform = null
})

describe('a stopped document takes its engines with it', () => {
  it('loads the page symbol font from its bundled asset before starting the document', () => {
    const terminal = mountTerminalWebDocument(plantHost(), () => {})
    const style = document.getElementById('orca-terminal-document-style')?.textContent ?? ''
    expect(style).toContain(`src:url('${terminalNerdFontUrl}') format('woff2')`)
    expect(style).not.toContain('data:font/')
    expect(style).toContain('unicode-range:U+E000-F8FF,U+F0000-FFFFD,U+100000-10FFFD')
    terminal.dispose()
  })

  // A pending swap owns two engines; count actual disposals to verify both stop.
  it('disposes both terminals when a second init is stopped before its swap commits', async () => {
    const host = plantHost()
    const engines: Array<ReturnType<typeof terminalDocumentDouble>> = []
    const started = createTerminalDocument({
      root: host,
      postToHost: () => {},
      hasEngine: () => true,
      installHostTransport: () => () => {},
      installErrorReporter: () => () => {},
      paintDocumentBackground: () => {},
      createTerminal: () => {
        const engine = terminalDocumentDouble()
        engines.push(engine)
        return engine.terminal
      },
      createUnicode11Addon: () => null,
      createWebglAddon: () => null
    })

    started.send({ ...INIT })
    // Commit the first engine before opening a second swap; otherwise there is only one engine to dispose.
    await settle()
    started.send({ ...INIT })
    expect(engines).toHaveLength(2)
    expect(engines.map((engine) => engine.disposals())).toEqual([0, 0])

    started.stop()

    expect(engines.map((engine) => engine.disposals())).toEqual([1, 1])
  })

  it('disposes the one terminal once when no swap is open', async () => {
    const host = plantHost()
    const engines: Array<ReturnType<typeof terminalDocumentDouble>> = []
    const started = createTerminalDocument({
      root: host,
      postToHost: () => {},
      hasEngine: () => true,
      installHostTransport: () => () => {},
      installErrorReporter: () => () => {},
      paintDocumentBackground: () => {},
      createTerminal: () => {
        const engine = terminalDocumentDouble()
        engines.push(engine)
        return engine.terminal
      },
      createUnicode11Addon: () => null,
      createWebglAddon: () => null
    })

    started.send({ ...INIT })
    await settle()
    expect(engines).toHaveLength(1)

    started.stop()

    expect(engines[0].disposals()).toBe(1)
  })
})

describe('terminal panes start when first selected', () => {
  it('starts only the selected document among several terminal tabs', () => {
    vi.useFakeTimers()
    const count = 3
    const refs = new Map<string, TerminalWebViewHandle>()
    const ready: string[] = []
    const engines: ReturnType<typeof terminalDocumentDouble>[] = []
    const replayed: string[] = []
    const addListener = vi.spyOn(document, 'addEventListener')
    const removeListener = vi.spyOn(document, 'removeEventListener')
    gridTerminal = () => {
      const engine = terminalDocumentDouble()
      engine.terminal.write = (data, callback) => {
        replayed.push(data)
        callback?.()
      }
      engines.push(engine)
      return engine.terminal
    }
    const noop = () => {}
    const onRef = (handle: string, ref: TerminalWebViewHandle | null) => {
      if (ref) {
        refs.set(handle, ref)
      } else {
        refs.delete(handle)
      }
    }
    const onWebReady = (handle: string) => {
      ready.push(handle)
      const ref = refs.get(handle)
      expect(ref).toBeDefined()
      void ref?.init({ ...INIT, initialData: `snapshot:${handle}`, frame: null })
    }
    const panes = (selected: number) =>
      Array.from({ length: count }, (_, index) =>
        createElement(TerminalPaneView, {
          key: index,
          handle: `terminal-${index}`,
          active: index === selected,
          keyboardLift: 0,
          textScale: 1,
          onRef,
          onWebReady,
          onTextScaleChange: noop,
          onCellBoxChange: noop,
          onSelectionMode: noop,
          onSelectionCopy: noop,
          onSelectionEvicted: noop,
          onClipboardWrite: noop,
          onModesChanged: noop,
          onKeyboardAvoidanceMetrics: noop,
          onHaptic: noop,
          onTerminalInput: noop,
          onTerminalQueryReply: noop,
          onTerminalTap: noop,
          onFileTap: noop,
          onOpenUrl: noop
        })
      )
    const documentListeners = () => addListener.mock.calls.length - removeListener.mock.calls.length
    try {
      act(() => {
        renderer = create(createElement('div', null, panes(0)), {
          createNodeMock: () => plantHost()
        })
      })
      expect(startedBuilds).toEqual([true])
      expect(ready).toEqual(['terminal-0'])
      expect(refs.size).toBe(1)
      expect(document.querySelectorAll(`.${HOST_CLASS}`)).toHaveLength(1)
      const perDocument = documentListeners()
      expect(perDocument).toBeGreaterThan(0)
      const firstHost = document.querySelector(`.${HOST_CLASS}`)
      act(() => {
        vi.advanceTimersByTime(32)
      })
      expect(replayed).toEqual(['\x1b[0msnapshot:terminal-0'])

      act(() => renderer?.update(createElement('div', null, panes(1))))
      expect(startedBuilds).toEqual([true, true])
      expect(ready).toEqual(['terminal-0', 'terminal-1'])
      expect(refs.size).toBe(2)
      expect(documentListeners()).toBe(2 * perDocument)
      act(() => {
        vi.advanceTimersByTime(32)
      })
      expect(replayed).toEqual(['\x1b[0msnapshot:terminal-0', '\x1b[0msnapshot:terminal-1'])

      act(() => renderer?.update(createElement('div', null, panes(0))))
      expect(document.querySelector(`.${HOST_CLASS}`)).toBe(firstHost)
      expect(startedBuilds).toEqual([true, true])
      expect(ready).toEqual(['terminal-0', 'terminal-1'])
      expect(engines.map((engine) => engine.disposals())).toEqual([0, 0])

      act(() => renderer?.unmount())
      renderer = null
      expect(refs.size).toBe(0)
      expect(document.querySelectorAll(`.${HOST_CLASS}`)).toHaveLength(0)
      expect(documentListeners()).toBe(0)
      expect(engines.map((engine) => engine.disposals())).toEqual([1, 1])
    } finally {
      vi.useRealTimers()
      addListener.mockRestore()
      removeListener.mockRestore()
    }
  })
})

describe('the page keeps its own capture buffer', () => {
  it('quotes the lines this document captured, and a second mount has none of them', () => {
    // Per-mount reporters append before quoting the buffer; embedded modules have no pre-engine head script.
    const host = plantHost()
    const posted: Array<Record<string, unknown>> = []
    const mounted = mountTerminalWebDocument(host, (message) => posted.push(message))

    window.dispatchEvent(
      new ErrorEvent('error', { message: 'first failure', error: new Error('first failure') })
    )
    window.dispatchEvent(
      new ErrorEvent('error', { message: 'second failure', error: new Error('second failure') })
    )

    const messages = posted.filter((message) => message.type === 'error').map((m) => m.message)
    expect(messages[0]).toContain('captured: first failure')
    expect(messages[1]).toContain('captured: first failure | second failure')

    mounted.dispose()
    const nextHost = plantHost()
    const nextPosted: Array<Record<string, unknown>> = []
    const next = mountTerminalWebDocument(nextHost, (message) => nextPosted.push(message))
    window.dispatchEvent(
      new ErrorEvent('error', { message: 'third failure', error: new Error('third failure') })
    )
    const nextMessages = nextPosted.filter((m) => m.type === 'error').map((m) => m.message)
    expect(nextMessages[0]).toContain('captured: third failure')
    expect(nextMessages[0]).not.toContain('first failure')
    next.dispose()
  })

  it("leaves a browser notice from elsewhere on the page out, so it can't fail a terminal", () => {
    const host = plantHost()
    const posted: Array<Record<string, unknown>> = []
    const mounted = mountTerminalWebDocument(host, (message) => posted.push(message))

    const message = 'ResizeObserver loop completed with undelivered notifications.'
    window.dispatchEvent(new ErrorEvent('error', { message }))

    expect(posted.filter((m) => m.type === 'error')).toEqual([])
    mounted.dispose()
  })
})

describe('a start that throws gives the host back', () => {
  it('empties the host and drops the class', () => {
    const host = plantHost()
    startThrows = new Error('engine missing')

    expect(() => mountTerminalWebDocument(host, () => {})).toThrow('engine missing')

    expect(host.innerHTML).toBe('')
    expect(host.classList.contains(HOST_CLASS)).toBe(false)
  })

  it('leaves the host carrying the markup and the class while the document is alive', () => {
    // Assert markup exists so an inert mount cannot satisfy cleanup checks.
    const host = plantHost()

    const mounted = mountTerminalWebDocument(host, () => {})

    expect(host.querySelector('#terminal-surface')).not.toBe(null)
    expect(host.classList.contains(HOST_CLASS)).toBe(true)

    mounted.dispose()
  })
})

describe("the document's overlays on the page", () => {
  it('sit inside the host, which is their containing block, rather than over the whole page', () => {
    const host = plantHost()
    const mounted = mountTerminalWebDocument(host, () => {})
    const position = (id: string) => getComputedStyle(host.querySelector(`#${id}`)!).position

    expect(getComputedStyle(host).position).toBe('relative')
    expect(position('selection-overlay')).toBe('absolute')
    expect(position('scroll-indicator')).toBe('absolute')

    mounted.dispose()
  })
})

describe('the component names the cause of a start that threw', () => {
  it('reports it to onEngineError instead of waiting out the readiness watchdog', () => {
    const host = plantHost()
    startThrows = new Error('engine missing')
    const engineErrors: string[] = []

    act(() => {
      renderer = create(
        createElement(TerminalWebView, { onEngineError: (message) => engineErrors.push(message) }),
        { createNodeMock: () => host }
      )
    })

    // Report the actual startup cause rather than the later readiness watchdog’s generic timeout.
    expect(engineErrors).toEqual(['terminal document failed to start - engine missing'])
  })

  it('reports nothing when the document starts', () => {
    const host = plantHost()
    const engineErrors: string[] = []

    act(() => {
      renderer = create(
        createElement(TerminalWebView, { onEngineError: (message) => engineErrors.push(message) }),
        { createNodeMock: () => host }
      )
    })

    expect(engineErrors).toEqual([])
  })
})

describe('the text scale a document is built at', () => {
  it('is the one the view mounted with, for a reloaded document too, as on native', () => {
    const host = plantHost()
    startThrows = new Error('engine missing')
    act(() => {
      renderer = create(createElement(TerminalWebView, { textScale: 1.25 }), {
        createNodeMock: () => host
      })
    })
    act(() => renderer?.update(createElement(TerminalWebView, { textScale: 1.5 })))
    startThrows = null
    act(() => {
      renderer?.root.find((node) => node.props.accessibilityRole === 'button').props.onPress()
    })
    expect(startedScales).toEqual([1.25, 1.25])
  })

  it('builds nothing before ready on the page for a view hidden when it mounted', () => {
    const host = plantHost()
    act(() => {
      renderer = create(createElement(TerminalWebView, { shownAtMount: false }), {
        createNodeMock: () => host
      })
    })
    expect(startedBuilds).toEqual([false])
  })
})

const CELL = { width: 7.5, height: 15 }
const FIT_390 = 390 / (7.5 * 55)

function gridDouble(cells: { measurable: boolean }): TerminalDocumentTerminal {
  const terminal = terminalDocumentDouble().terminal
  const cell = () => {
    const k = cells.measurable ? terminal.options.fontSize / 13 : 0
    return { width: CELL.width * k, height: CELL.height * k }
  }
  const grid = Object.assign(terminal, {
    cols: 55,
    rows: 40,
    _core: {
      _renderService: {
        get dimensions() {
          return { css: { cell: cell() } }
        }
      }
    }
  })
  grid.resize = (cols: number, rows: number) => {
    grid.cols = cols
    grid.rows = rows
  }
  return grid
}

async function mountedOverGrid({ laidOutFirst = true } = {}) {
  const cells = { measurable: true }
  const grids: TerminalDocumentTerminal[] = []
  gridTerminal = () => {
    const grid = gridDouble(cells)
    grids.push(grid)
    return grid
  }
  const host = plantHost()
  let box = { width: 390, height: 600 }
  host.getBoundingClientRect = () => new DOMRect(0, 134, box.width, box.height)
  const mounted = mountTerminalWebDocument(host, () => {})
  // Trace the public style writer because init replaces surfaces and Happy DOM proxies CSS.
  const scales: number[] = []
  const write = CSSStyleDeclaration.prototype.setProperty
  const trace = vi.spyOn(CSSStyleDeclaration.prototype, 'setProperty').mockImplementation(function (
    this: CSSStyleDeclaration,
    name,
    value,
    priority
  ) {
    if (name === 'transform') {
      const scale = /scale\(([^)]*)\)/.exec(String(value))
      if (scale) {
        scales.push(Number(scale[1]))
      }
    }
    write.call(this, name, value, priority)
  })
  restoreTransform = () => trace.mockRestore()
  let id = 0
  const send = (command: TerminalWebViewCommand) => mounted.send({ ...command, id: ++id })
  const layOut = (width: number, height: number) => {
    box = { width, height }
    mounted.notifyViewport()
  }
  if (laidOutFirst) {
    layOut(390, 600)
  }
  send({
    type: 'init',
    cols: 55,
    rows: 40,
    initialData: '',
    preserveScroll: false,
    frame: { width: 390, height: 600 }
  })
  await framesUntil(() => scales.at(-1) === FIT_390)
  return { mounted, scales, send, layOut, cells, grid: () => grids.at(-1)! }
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

async function framesUntil(done: () => boolean, frames = 30) {
  for (let frame = 0; frame < frames && !done(); frame++) {
    await nextFrame()
  }
  expect(done()).toBe(true)
}

describe("the page pushes its terminal frame's box into the document", () => {
  it('refits on a box RN laid out, through the host View, with no ResizeObserver of its own', () => {
    let observers = 0
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor() {
          observers += 1
        }
        observe() {}
        disconnect() {}
      }
    )
    try {
      const host = plantHost()
      let height = 600
      host.getBoundingClientRect = () => new DOMRect(0, 134, 390, height)
      act(() => {
        renderer = create(createElement(TerminalWebView, {}), { createNodeMock: () => host })
      })
      const surface = host.querySelector<HTMLElement>('#terminal-surface')!
      expect(surface.style.transform).toBe('')
      const laidOut = renderer!.root.findAll((node) => typeof node.props.onLayout === 'function')
      expect(laidOut).toHaveLength(1)
      height = 560
      act(() => {
        laidOut[0]!.props.onLayout({ nativeEvent: { layout: { width: 390, height: 560 } } })
      })
      expect(surface.style.transform).toContain('scale(1)')
      expect(observers).toBe(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps pan and zoom across hide and show, and refits when the box really changes', async () => {
    const { mounted, scales, layOut } = await mountedOverGrid()
    const fitted = scales.length
    layOut(0, 0)
    layOut(390, 600)
    await nextFrame()
    await nextFrame()
    expect(scales).toHaveLength(fitted)

    layOut(300, 600)
    await framesUntil(() => scales.at(-1) === 300 / (7.5 * 55))
    mounted.dispose()
  })

  it('keeps pan and zoom when RN laid the host out before the mount existed', async () => {
    const { mounted, scales, layOut } = await mountedOverGrid({ laidOutFirst: false })
    const fitted = scales.length
    layOut(0, 0)
    layOut(390, 600)
    await nextFrame()
    await nextFrame()
    expect(scales).toHaveLength(fitted)
    mounted.dispose()
  })

  it('holds a fit asked for while hidden and lands it on show', async () => {
    const { mounted, scales, send, layOut } = await mountedOverGrid()
    layOut(0, 0)
    send({ type: 'resize', cols: 80, rows: 40, frame: null })
    await nextFrame()
    await nextFrame()
    expect(scales.at(-1)).toBe(FIT_390)
    layOut(390, 600)
    await framesUntil(() => scales.at(-1) === 390 / (7.5 * 80))
    // Consume hidden fit once; later hide/show must preserve user pan.
    const landed = scales.length
    layOut(0, 0)
    layOut(390, 600)
    await nextFrame()
    await nextFrame()
    expect(scales).toHaveLength(landed)
    mounted.dispose()
  })

  it('never commits a blind fit when the grid cannot be measured while hidden', async () => {
    // Re-init while covered so DOM cell measurement is zero until the screen returns.
    const { mounted, scales, send, layOut, cells } = await mountedOverGrid()
    layOut(0, 0)
    const shown = scales.length
    cells.measurable = false
    send({ type: 'init', cols: 55, rows: 40, initialData: '', preserveScroll: false, frame: null })
    for (let frame = 0; frame < 75; frame++) {
      await nextFrame()
    }
    expect(scales.slice(shown)).not.toContain(1)
    cells.measurable = true
    layOut(390, 600)
    await framesUntil(() => scales.at(-1) === FIT_390)
    mounted.dispose()
  })

  it('fits a text scale too large to resize the grid while visible', async () => {
    const { mounted, scales, send, layOut, grid } = await mountedOverGrid()
    layOut(280, 600)
    send({ type: 'resize', cols: 55, rows: 40, frame: { width: 280, height: 600 } })
    await framesUntil(() => scales.at(-1) === 280 / (7.5 * 55))
    send({ type: 'set-font-scale', fontScale: 2 })
    await framesUntil(() => scales.at(-1) === 280 / (15 * 55))
    expect(grid().cols).toBe(55)
    mounted.dispose()
  })

  it('refits on show after a text scale too large to resize the grid while hidden', async () => {
    const { mounted, scales, send, layOut } = await mountedOverGrid()
    layOut(280, 600)
    send({ type: 'resize', cols: 55, rows: 40, frame: { width: 280, height: 600 } })
    await framesUntil(() => scales.at(-1) === 280 / (7.5 * 55))
    layOut(0, 0)
    send({ type: 'set-font-scale', fontScale: 2 })
    await nextFrame()
    await nextFrame()
    layOut(280, 600)
    await framesUntil(() => scales.at(-1) === 280 / (15 * 55))
    mounted.dispose()
  })

  it('resizes the grid to a text scale changed while hidden, and fits it on show', async () => {
    const { mounted, scales, send, layOut, grid } = await mountedOverGrid()
    layOut(0, 0)
    send({ type: 'set-font-scale', fontScale: 0.8 })
    await framesUntil(() => grid().cols === 67)
    const hidden = scales.length
    layOut(390, 600)
    await framesUntil(() => scales.length > hidden)
    expect(scales.at(-1)).toBe(1)
    mounted.dispose()
  })
})
