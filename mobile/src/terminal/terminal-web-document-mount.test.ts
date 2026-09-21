// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { terminalDocumentDouble } from './document/document-terminal-double.test-support'
import { TERMINAL_DOCUMENT_MARKUP } from './terminal-webview-html'

/**
 * The page's mount, as a unit.
 *
 * Every other reading of it is the render check, which drives the whole page bundle in a real
 * browser: right for behaviour, and too coarse for the three things below, each of which is one
 * line of this module doing the thing no happy path reaches — a dispose while a surface swap is
 * open, a start that throws, and the component's report of that throw.
 *
 * The document is the real generated factory. Only its *arrival* is a seam here, so a start can be
 * made to throw without a stub standing in for the program under test.
 */
/** Set for the length of one case; the factory throws it instead of building a document. */
let startThrows: Error | null = null

vi.mock('./terminal-webview-document-factory.generated', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./terminal-webview-document-factory.generated')>()
  return {
    createTerminalDocument: (host: Parameters<typeof actual.createTerminalDocument>[0]) => {
      if (startThrows) {
        throw startThrows
      }
      return actual.createTerminalDocument(host)
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

const { createTerminalDocument } = await import('./terminal-webview-document-factory.generated')
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

beforeEach(() => {
  startThrows = null
  document.body.innerHTML = ''
  document.head.innerHTML = ''
})

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
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
