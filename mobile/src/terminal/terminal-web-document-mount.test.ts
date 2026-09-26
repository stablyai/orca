// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { terminalDocumentDouble } from './document/document-terminal-double.test-support'
import type { TerminalDocumentTerminal } from './document/document-terminal-shape'
import type { TerminalWebViewCommand } from './terminal-webview-messages'
import { TERMINAL_DOCUMENT_MARKUP } from './terminal-webview-html'

/**
 * The page's mount, as a unit.
 *
 * Every other reading of it is the render check, which drives the whole page bundle in a real
 * browser: right for behaviour, and too coarse for the three things below, each of which is one
 * line of this module doing the thing no happy path reaches — a dispose while a surface swap is
 * open, a start that throws, and the component's report of that throw.
 *
 * The document is the real factory, hand-written since ruling 25. Only its *arrival* is a seam
 * here, so a start can be made to throw without a stub standing in for the program under test.
 */
/** Set for the length of one case; the factory throws it instead of building a document. */
let startThrows: Error | null = null
/** Set for the length of one case; the document builds its terminals here instead of xterm. */
let gridTerminal: (() => TerminalDocumentTerminal) | null = null

vi.mock('./document/create-terminal-document', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./document/create-terminal-document')>()
  return {
    ...actual,
    createTerminalDocument: (host: Parameters<typeof actual.createTerminalDocument>[0]) => {
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
vi.mock('lucide-react-native', () => ({ RefreshCw: 'Icon' }))

const { createTerminalDocument } = await import('./document/create-terminal-document')
const { mountTerminalWebDocument } = await import('./terminal-web-document-mount')
const { TerminalWebView } = await import('./TerminalWebView.web')

const HOST_CLASS = 'orca-terminal-document-host'

/** One host element carrying the document's markup, as the mount plants it. */
function plantHost() {
  const host = document.createElement('div')
  host.innerHTML = TERMINAL_DOCUMENT_MARKUP
  document.body.appendChild(host)
  return host
}

/** Long enough for init's frame and its write drain, which is where a swap commits. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

const INIT = { type: 'init', cols: 80, rows: 24, initialData: '', preserveScroll: false } as const

let renderer: ReactTestRenderer | null = null
let restoreTransform: (() => void) | null = null

beforeEach(() => {
  startThrows = null
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
  /**
   * `stopTerminalInit`'s set (ruling 22's disposal): a swap that never committed leaves the
   * committed terminal with nothing pointing at it, so `scope.term` alone is not every engine the
   * document opened. The oracle is the doubles' own dispose counts.
   */
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
    // The precondition for two engines: the first init has to commit, because a swap's `oldTerm`
    // is the committed terminal. Without this the second init would replace an uncommitted one
    // and there would be a single engine to dispose for the wrong reason.
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

    // `scope.term` and `scope.committedTerm` are the same object here, which is what the set
    // deduplicates: a plain pair of calls would dispose it twice.
    expect(engines[0].disposals()).toBe(1)
  })
})

describe('the page keeps its own capture buffer', () => {
  it('quotes the lines this document captured, and a second mount has none of them', () => {
    // The buffer is written by the document's own reporter: `startHostNotify` installs it through
    // `installErrorReporter`, which on the page is a `window` error listener, and every error it
    // forwards is appended before the report that quotes it. What the page has no use for is the
    // WebView's head script, which captures what fails before any document exists.
    const host = plantHost()
    const posted: Array<Record<string, unknown>> = []
    const mounted = mountTerminalWebDocument(host, (message) => posted.push(message))

    window.dispatchEvent(new ErrorEvent('error', { message: 'first failure' }))
    window.dispatchEvent(new ErrorEvent('error', { message: 'second failure' }))

    const messages = posted.filter((message) => message.type === 'error').map((m) => m.message)
    expect(messages[0]).toContain('captured: first failure')
    expect(messages[1]).toContain('captured: first failure | second failure')

    // A second mount is a second buffer: the first document's lines are not the second's to quote.
    mounted.dispose()
    const nextHost = plantHost()
    const nextPosted: Array<Record<string, unknown>> = []
    const next = mountTerminalWebDocument(nextHost, (message) => nextPosted.push(message))
    window.dispatchEvent(new ErrorEvent('error', { message: 'third failure' }))
    const nextMessages = nextPosted.filter((m) => m.type === 'error').map((m) => m.message)
    expect(nextMessages[0]).toContain('captured: third failure')
    expect(nextMessages[0]).not.toContain('first failure')
    next.dispose()
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
    // The control: both assertions above hold for a mount that never planted anything.
    const host = plantHost()

    const mounted = mountTerminalWebDocument(host, () => {})

    expect(host.querySelector('#terminal-surface')).not.toBe(null)
    expect(host.classList.contains(HOST_CLASS)).toBe(true)

    mounted.dispose()
  })
})

describe("the document's overlays on the page", () => {
  it('sit inside the host, which is their containing block, rather than over the whole page', () => {
    // `position: fixed` is the WebView's frame; on the page it is the window, header and all.
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

    // The cause, not just the failure: the readiness watchdog's own message is what the page said
    // before this path existed, and it names nothing.
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

const CELL = { width: 7.5, height: 15 }
const FIT_390 = 390 / (7.5 * 55)

/**
 * A laid-out 55x40 grid whose cells scale with the font, as xterm's do, or read 0 while `cells`
 * says they cannot be measured: xterm's DOM measure on a `display:none` host, where no
 * OffscreenCanvas is available.
 */
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

/**
 * A mounted page document over a grid, whose host box the case sets and pushes as RN layout does:
 * react-native-web's `onLayout` reports a `display:none` screen as 0x0 and its return as the old box.
 */
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
  // Every surface transform the document writes; a refit writes one even when nothing moved. Read
  // off the style prototype because an init swaps the surface element for a fresh one.
  const scales: number[] = []
  const proto: object = Object.getPrototypeOf(host.style)
  const own = Object.getOwnPropertyDescriptor(proto, 'transform')!
  const write = own.set!
  Object.defineProperty(proto, 'transform', {
    ...own,
    set(this: CSSStyleDeclaration, value: string) {
      const scale = /scale\(([^)]*)\)/.exec(String(value))
      if (scale) {
        scales.push(Number(scale[1]))
      }
      write.call(this, value)
    }
  })
  restoreTransform = () => Object.defineProperty(proto, 'transform', own)
  let id = 0
  const send = (command: TerminalWebViewCommand) => mounted.send({ ...command, id: ++id })
  const layOut = (width: number, height: number) => {
    box = { width, height }
    mounted.notifyViewport()
  }
  if (laidOutFirst) {
    layOut(390, 600)
  }
  send({ type: 'init', cols: 55, rows: 40, initialData: '', preserveScroll: false })
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
    // Native never refits on navigation: its WebView keeps its size while another screen covers it.
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
    // The first layout can land before the document does; the box it reported is still the box.
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
    send({ type: 'resize', cols: 80, rows: 40 })
    await nextFrame()
    await nextFrame()
    expect(scales.at(-1)).toBe(FIT_390)
    layOut(390, 600)
    await framesUntil(() => scales.at(-1) === 390 / (7.5 * 80))
    // The held fit is spent: a second hide and show must not run it again over the user's pan.
    const landed = scales.length
    layOut(0, 0)
    layOut(390, 600)
    await nextFrame()
    await nextFrame()
    expect(scales).toHaveLength(landed)
    mounted.dispose()
  })

  it('never commits a blind fit when the grid cannot be measured while hidden', async () => {
    // A reconnect re-inits under a covering screen, where xterm's DOM measure reads every cell as 0.
    const { mounted, scales, send, layOut, cells } = await mountedOverGrid()
    layOut(0, 0)
    const shown = scales.length
    cells.measurable = false
    send({ type: 'init', cols: 55, rows: 40, initialData: '', preserveScroll: false })
    // Past the retry loop's 60-frame cap, where a fit that did not wait commits scale 1.
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
    await framesUntil(() => scales.at(-1) === 280 / (7.5 * 55))
    // fontPxForScale(2) = 26 px: 280 / (7.5 x 2) = 18 columns, under MIN_FIT_COLS, so no resize.
    send({ type: 'set-font-scale', fontScale: 2 })
    await framesUntil(() => scales.at(-1) === 280 / (15 * 55))
    expect(grid().cols).toBe(55)
    mounted.dispose()
  })

  it('refits on show after a text scale too large to resize the grid while hidden', async () => {
    const { mounted, scales, send, layOut } = await mountedOverGrid()
    layOut(280, 600)
    await framesUntil(() => scales.at(-1) === 280 / (7.5 * 55))
    layOut(0, 0)
    // fontPxForScale(2) = 26 px: 280 / (7.5 x 2) = 18 columns, under MIN_FIT_COLS, so no resize.
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
    // fontPxForScale(0.8) = 10 px: 390 / (7.5 x 10/13) = 67 columns, where stale cells give 52.
    await framesUntil(() => grid().cols === 67)
    const hidden = scales.length
    layOut(390, 600)
    await framesUntil(() => scales.length > hidden)
    expect(scales.at(-1)).toBe(1)
    mounted.dispose()
  })
})
