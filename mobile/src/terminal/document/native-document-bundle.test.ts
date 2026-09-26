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

/**
 * The bundle runs, and it is the same document.
 *
 * Ruling 25 ends the byte pin: the phone's script is an esbuild bundle of these modules rather than
 * text a concatenator emits, so it cannot be compared line by line with a golden — and the bundler
 * renames what collides, which made every text assertion against it a match on a rename.
 *
 * What replaces it is this: the bundle is executed exactly as the WebView executes it, and then
 * driven through the transport the WebView uses. That covers the whole path no text assertion ever
 * touched — the window listener, the frame parse, the router and `init` — and it is the one thing
 * that says the bundle is a working document rather than a well-formed string.
 *
 * This file, the module tests beside it and the page's render check are together what the golden
 * was: the golden said the text had not moved, the module tests say each part does its job, the
 * render check says the page's copy paints, and this says the phone's copy runs and answers.
 *
 * `tap-routing` and `wheel-scroll` run the same bundle for behaviour of their own; this is the
 * bring-up, so a failure here says the bundle is broken rather than that a gesture is.
 */
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

/** The frames the shell posts, as the shell posts them. */
function post(message: Record<string, unknown>) {
  window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }))
}

/**
 * The listeners a document installs, captured around one evaluation.
 *
 * Both targets, because the WebView's transport takes `message` on `window` for the injected bridge
 * and on `document` for Android's dispatch. The removals come back with them: the WebView never
 * stops its document and neither does a case, so a case that has finished has to take its own
 * listeners off or the next one's frames reach two documents.
 */
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

/** Every listener this file's documents are still holding, taken off between cases. */
const liveListeners: Array<() => void> = []

afterEach(() => {
  while (liveListeners.length > 0) {
    liveListeners.pop()!()
  }
})

/** The WebView's own act: evaluate the string, and keep what it installed so the case can undo it. */
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
    // The three globals the WebView's HTML declares before the script runs: the bridge it posts
    // through, the engine the script reads, and the error buffer the shell's handler fills.
    Object.assign(globalThis, {
      ReactNativeWebView: {
        postMessage: (message: string) => posted.push(JSON.parse(message))
      },
      Terminal,
      __engineErrors: []
    })

    // The WebView evaluates this string; so does this case.
    evaluateBundle()

    // The document's last act at start: it has the engine, so it says so.
    expect(posted.map((message) => message.type)).toContain('web-ready')

    // And the transport it installed for itself carries a host frame into the router.
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
    // Read from the router, not assumed: `set-theme` before init applies to the scope and paints
    // through the seam, and `write` normalises, queues and pumps — the pump returns at once because
    // there is no terminal. Then `init` resets the queue and the mode scan, so the chunk that
    // arrived early is dropped rather than replayed under the snapshot, and the init frame's own
    // theme wins over the early one.
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
    // Still the same document afterwards, which is what says the out-of-order frames cost nothing.
    post({ type: 'ping', id: 4 })
    expect(posted).toContainEqual({ type: 'pong', pingId: 4 })
  })

  it('keeps the transport it installed, where the page installs none', () => {
    // The WebView never stops its document, so the listeners it takes are for the life of the page
    // it owns. A page mounting the same modules is a guest: `installHostTransport` is the seam that
    // says so, and a host that installs nothing takes none of the shell's own frames.
    document.body.innerHTML = TERMINAL_DOCUMENT_MARKUP
    const { Terminal } = engineDouble()
    Object.assign(globalThis, {
      ReactNativeWebView: { postMessage: () => {} },
      Terminal,
      __engineErrors: []
    })

    expect(evaluateBundle()).toEqual(['window', 'document'])
    // Nothing stopped it, and the transport is still live: a frame posted now still routes.
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
    // The artifact is committed by a postinstall run whose working directory is whatever the
    // installer happened to be in, and the case below compares it with a build made here. So the
    // build has to be cwd-independent, which is what `absWorkingDir` buys: without it this digest
    // and the one from the temp directory differ, and the artifact carries a machine path.
    // `import.meta.dirname`, because a case in the DOM environment has no file URL to convert.
    const generator = join(
      import.meta.dirname,
      '../../../scripts/build-terminal-document-script.mjs'
    )
    const here = createHash('sha256').update(TERMINAL_DOCUMENT_SCRIPT).digest('hex')
    expect(bundleDigestBuiltFrom(tmpdir(), generator, 'terminalDocumentBundle')).toBe(here)
    expect(machinePathCommentsIn(TERMINAL_DOCUMENT_SCRIPT)).toEqual([])
  }, 30_000)

  it('carries the document and nothing else: no dependency rides into the WebView', async () => {
    // The document imports ordinary modules now, so an import added anywhere in its graph reaches
    // the phone's script. `storage/preferences` did: one constant pulled AsyncStorage and its two
    // dependencies into a string with nothing to store, which is why the presets are a leaf module.
    //
    // One build, read four ways. The count is exact because a module arriving in the phone's script
    // is a review event, and the last assertion is what makes the other three about the artifact
    // that ships rather than about a bundle this case built for itself.
    const { script, inputs } = await terminalDocumentBundle()
    expect(inputs.filter((input) => input.includes('node_modules'))).toEqual([])
    // 48: `cell-metrics-probe` measures the cell box for web-ready before any terminal exists.
    expect(inputs).toHaveLength(48)
    expect(script).not.toContain('__commonJS')
    // `__esm` wrappers are esbuild's answer to a cycle, and a cycle would make a module's top level
    // run at first import rather than where the bundle places it.
    expect(script).not.toContain('__esm(')
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
    // The engine global is the one the bundle reads for readiness, and a script tag that failed to
    // load leaves it undefined. The precondition for the case above.
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
