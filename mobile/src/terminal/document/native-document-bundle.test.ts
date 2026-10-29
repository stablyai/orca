// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { terminalDocumentBundle } from '../../../scripts/build-terminal-document-script.mjs'
import { createTerminalDocument } from './create-terminal-document'
import { TERMINAL_DOCUMENT_SCRIPT } from '../terminal-webview-document-script.generated'
import { TERMINAL_DOCUMENT_MARKUP } from '../terminal-webview-html'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import {
  bundleDigestBuiltFrom,
  machinePathCommentsIn
} from '../../test-support/webview-document-bundle-digest'

// Execute the shipped bundle through native message transport; structural module checks cannot prove the WebView entry runs.
function engineDouble() {
  const opened: HTMLElement[] = []
  const written: string[] = []
  class Terminal {
    cols = 80
    rows = 24
    options = { theme: {}, minimumContrastRatio: 3, fontSize: 13 }
    buffer = {
      active: {
        length: 1,
        viewportY: 0,
        baseY: 0,
        cursorY: 0,
        type: 'normal',
        getLine: () => undefined
      }
    }
    unicode = { activeVersion: '6' }
    write(data: string, callback?: () => void) {
      written.push(data)
      callback?.()
    }
    open(element: HTMLElement) {
      opened.push(element)
    }
    loadAddon() {}
    attachCustomKeyEventHandler() {}
    onData() {
      return { dispose() {} }
    }
    onLineFeed() {
      return { dispose() {} }
    }
    onScroll() {
      return { dispose() {} }
    }
    onWriteParsed() {
      return { dispose() {} }
    }
    clear() {}
    reset() {}
    refresh() {}
    resize() {}
    selectAll() {}
    select() {}
    clearSelection() {}
    scrollLines() {}
    scrollToLine() {}
    scrollToBottom() {}
    dispose() {}
  }
  return { Terminal, opened, written }
}

function post(message: Record<string, unknown>) {
  window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }))
}

// Capture and remove listeners on both targets; native never stops its page-owned document, but tests must isolate evaluations.
function recordMessageListeners(run: () => void) {
  const added: string[] = []
  const removals: Array<() => void> = []
  const windowAdd = window.addEventListener
  const documentAdd = document.addEventListener
  const record = (
    target: Window | Document,
    name: string,
    args: Parameters<typeof window.addEventListener>
  ) => {
    if (args[0] === 'message') {
      added.push(name)
      removals.push(() => target.removeEventListener(args[0], args[1], args[2]))
    }
  }
  window.addEventListener = (...args: Parameters<typeof window.addEventListener>) => {
    record(window, 'window', args)
    return windowAdd.apply(window, args)
  }
  document.addEventListener = (...args: Parameters<typeof document.addEventListener>) => {
    record(document, 'document', args)
    return documentAdd.apply(document, args)
  }
  try {
    run()
  } finally {
    window.addEventListener = windowAdd
    document.addEventListener = documentAdd
  }
  return { added, removals }
}

const liveListeners: Array<() => void> = []

afterEach(() => {
  while (liveListeners.length > 0) {
    liveListeners.pop()!()
  }
})

function evaluateBundle() {
  const { added, removals } = recordMessageListeners(() => {
    new Function(TERMINAL_DOCUMENT_SCRIPT)()
  })
  liveListeners.push(...removals)
  return added
}

describe('the bundled native document', () => {
  it('starts, reports itself ready, and opens the engine on an init frame', () => {
    document.body.innerHTML = TERMINAL_DOCUMENT_MARKUP
    const posted: Record<string, unknown>[] = []
    const { Terminal, opened } = engineDouble()
    Object.assign(globalThis, {
      ReactNativeWebView: {
        postMessage: (message: string) => posted.push(JSON.parse(message))
      },
      Terminal,
      __engineErrors: []
    })

    evaluateBundle()

    expect(posted.map((message) => message.type)).toContain('web-ready')

    window.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'init',
          cols: 80,
          rows: 24,
          initialData: '',
          preserveScroll: false
        })
      })
    )
    expect(opened).toHaveLength(1)
    expect(document.getElementById('terminal-surface')?.contains(opened[0]!)).toBe(true)
  })

  it('answers a ping through the bridge, which is what native readiness reads', () => {
    document.body.innerHTML = TERMINAL_DOCUMENT_MARKUP
    const posted: Record<string, unknown>[] = []
    const { Terminal } = engineDouble()
    Object.assign(globalThis, {
      ReactNativeWebView: {
        postMessage: (message: string) => posted.push(JSON.parse(message))
      },
      Terminal,
      __engineErrors: []
    })
    evaluateBundle()

    window.dispatchEvent(
      new MessageEvent('message', { data: JSON.stringify({ type: 'ping', id: 9 }) })
    )
    expect(posted).toContainEqual({ type: 'pong', pingId: 9 })
  })

  it('takes a theme and a write before init, and init is what decides they are stale', async () => {
    // Early writes must be superseded by init’s snapshot and theme, not replayed underneath it.
    document.body.innerHTML = TERMINAL_DOCUMENT_MARKUP
    const posted: Record<string, unknown>[] = []
    const { Terminal, opened, written } = engineDouble()
    Object.assign(globalThis, {
      ReactNativeWebView: {
        postMessage: (message: string) => posted.push(JSON.parse(message))
      },
      Terminal,
      __engineErrors: []
    })
    evaluateBundle()

    post({ type: 'set-theme', terminalTheme: { theme: { background: 'rgb(1, 2, 3)' } } })
    expect(document.documentElement.style.background).toBe('rgb(1, 2, 3)')
    post({ type: 'write', data: 'early chunk' })
    expect(posted.map((message) => message.type)).not.toContain('error')

    post({
      type: 'init',
      cols: 80,
      rows: 24,
      initialData: 'replayed',
      terminalTheme: { theme: { background: 'rgb(4, 5, 6)' } },
      preserveScroll: false
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(opened).toHaveLength(1)
    expect(document.documentElement.style.background).toBe('rgb(4, 5, 6)')
    expect(written.join('')).toContain('replayed')
    expect(written.join('')).not.toContain('early chunk')
    post({ type: 'ping', id: 4 })
    expect(posted).toContainEqual({ type: 'pong', pingId: 4 })
  })

  it('keeps the transport it installed, where the page installs none', () => {
    // Native transport lives for its page; embedded documents install no shell-message listeners.
    document.body.innerHTML = TERMINAL_DOCUMENT_MARKUP
    const { Terminal } = engineDouble()
    Object.assign(globalThis, {
      ReactNativeWebView: { postMessage: () => {} },
      Terminal,
      __engineErrors: []
    })

    expect(evaluateBundle()).toEqual(['window', 'document'])
    const posted: Record<string, unknown>[] = []
    Object.assign(globalThis, {
      ReactNativeWebView: {
        postMessage: (message: string) => posted.push(JSON.parse(message))
      }
    })
    post({ type: 'ping', id: 7 })
    expect(posted).toContainEqual({ type: 'pong', pingId: 7 })

    const host = document.createElement('div')
    host.innerHTML = TERMINAL_DOCUMENT_MARKUP
    document.body.appendChild(host)
    const { added: pageListeners } = recordMessageListeners(() => {
      createTerminalDocument({
        root: host,
        hasEngine: () => true,
        installHostTransport: () => () => {},
        postToHost: () => {},
        paintDocumentBackground: () => {},
        installErrorReporter: () => () => {},
        capturedEngineErrors: () => []
      }).stop()
    })
    expect(pageListeners).toEqual([])
  })

  it('is the same bytes wherever its generator was run from', () => {
    // Postinstall can run from another cwd; pin build paths so the shipped artifact stays reproducible and contains no machine paths.
    const generator = join(
      import.meta.dirname,
      '../../../scripts/build-terminal-document-script.mjs'
    )
    const here = createHash('sha256').update(TERMINAL_DOCUMENT_SCRIPT).digest('hex')
    expect(bundleDigestBuiltFrom(tmpdir(), generator, 'terminalDocumentBundle')).toBe(here)
    expect(machinePathCommentsIn(TERMINAL_DOCUMENT_SCRIPT)).toEqual([])
  }, 30_000)

  it('ships the current document bundle without runtime dependencies', async () => {
    // A transitive preferences import once bundled AsyncStorage into the phone’s script; verify the built graph/artifact keeps presets dependency-free.
    const { script, inputs } = await terminalDocumentBundle()
    expect(inputs.filter((input) => input.includes('node_modules'))).toEqual([])
    expect(TERMINAL_DOCUMENT_SCRIPT).toBe(script)
  }, 30_000)

  it('reports a missing engine rather than starting without one', () => {
    document.body.innerHTML = TERMINAL_DOCUMENT_MARKUP
    const posted: Record<string, unknown>[] = []
    Object.assign(globalThis, {
      ReactNativeWebView: {
        postMessage: (message: string) => posted.push(JSON.parse(message))
      },
      __engineErrors: []
    })
    Reflect.deleteProperty(globalThis, 'Terminal')

    evaluateBundle()

    expect(posted.map((message) => message.type)).not.toContain('web-ready')
    expect(posted).toContainEqual(
      expect.objectContaining({
        type: 'error',
        fatal: true,
        message: expect.stringContaining('terminal engine missing')
      })
    )
  })
})
