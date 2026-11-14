// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { TERMINAL_DOCUMENT_SCRIPT } from './terminal-webview-document-script.generated'
import './native-terminal-html'
import { TERMINAL_DOCUMENT_MARKUP } from '../terminal-webview-html/document-markup'
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
