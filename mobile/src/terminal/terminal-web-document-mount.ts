import { Terminal } from '@xterm/xterm'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import type { TerminalDocumentTerminal } from './document/document-terminal-shape'
import type { TerminalDocumentStart, TerminalViewportChange } from './document/document-host-seams'
import { TERMINAL_DOCUMENT_ELEMENT_STYLE, TERMINAL_DOCUMENT_MARKUP } from './terminal-webview-html'
import { scopeStyleToHost } from '../style-scoping/document-style-scoping'
import {
  TERMINAL_SYMBOLS_FONT_CSS,
  XTERM_ENGINE_CSS
} from './terminal-webview-engine-css.generated'
import terminalNerdFontUrl from '../../assets/fonts/SymbolsNerdFontMono-Regular.woff2'
import { terminalNerdFontCss } from './terminal-font-face-css.mjs'
import { createTerminalDocument } from './document/create-terminal-document'
import type { TerminalWebViewCommand } from './terminal-webview-messages'

// Mount the native document factory with page-owned seams and fresh scope so overlapping terminals cannot share state.

export type TerminalWebDocument = {
  send: (command: TerminalWebViewCommand & { id: number }) => void
  notifyViewport: () => void
  dispose: () => void
}

const STYLE_ELEMENT_ID = 'orca-terminal-document-style'

const HOST_CLASS = 'orca-terminal-document-host'

// Prefix a page-wide sheet once; it matches nothing after the host class is removed.
// Shadow roots would require reparsing the document and xterm sheets inside every mount.
function ensureDocumentStyle() {
  if (document.getElementById(STYLE_ELEMENT_ID)) {
    return
  }
  const style = document.createElement('style')
  style.id = STYLE_ELEMENT_ID
  const prefix = `.${HOST_CLASS}`
  const engine = scopeStyleToHost(XTERM_ENGINE_CSS, prefix)
  const elements = scopeStyleToHost(TERMINAL_DOCUMENT_ELEMENT_STYLE, prefix)
  style.textContent = `${terminalNerdFontCss(terminalNerdFontUrl)}\n${TERMINAL_SYMBOLS_FONT_CSS}\n${engine}\n${elements}\n${hostFrameStyle(prefix)}`
  document.head.appendChild(style)
}

// Use the terminal host as overlay containing block; fixed positioning would include the app header.
function hostFrameStyle(prefix: string) {
  return `${prefix} { position: relative; }
${prefix} #selection-overlay, ${prefix} #scroll-indicator { position: absolute; }`
}

// Null WebGL addon selects the existing DOM fallback; log it because rendering is slower.
function createPageWebglAddon(onFallback: (reason: string) => void) {
  try {
    return new WebglAddon()
  } catch (error) {
    onFallback(error instanceof Error ? error.message : String(error))
    return null
  }
}

// Synchronous factory calls guarantee a cleanup handle exists before component disposal can run.
export function mountTerminalWebDocument(
  host: HTMLElement,
  receive: (message: Record<string, unknown>) => void,
  start: TerminalDocumentStart = { textScale: 1, shown: true }
): TerminalWebDocument {
  ensureDocumentStyle()
  host.classList.add(HOST_CLASS)
  host.innerHTML = TERMINAL_DOCUMENT_MARKUP
  const viewport = pageViewport(host)
  const started = startDocumentOrGiveTheHostBack(host, receive, start, viewport)

  return {
    send: (command) => {
      started.send(command)
    },
    notifyViewport: viewport.notify,
    dispose: () => {
      started.stop()
      host.innerHTML = ''
      host.classList.remove(HOST_CLASS)
    }
  }
}

// Factory failure unwinds document effects; remove this mount’s remaining markup/class when no handle can own them.
function startDocumentOrGiveTheHostBack(
  host: HTMLElement,
  receive: (message: Record<string, unknown>) => void,
  start: TerminalDocumentStart,
  viewport: PageViewport
) {
  try {
    return startPageDocument(host, receive, start, viewport)
  } catch (error) {
    host.innerHTML = ''
    host.classList.remove(HOST_CLASS)
    throw error
  }
}

type PageViewport = ReturnType<typeof pageViewport>

// Keep the last real box across display:none; showing the same size is visibility, not resize. Use client rects over rounded RN offsets.
function pageViewport(host: HTMLElement) {
  // RN layout may precede mount; seed from the current host box.
  const seed = host.getBoundingClientRect()
  let laidOut = { width: seed.width, height: seed.height }
  let onChange: ((change: TerminalViewportChange) => void) | null = null
  return {
    rect: () => {
      const box = host.getBoundingClientRect()
      const hidden = box.width <= 0
      const size = hidden ? laidOut : box
      return { left: box.left, top: box.top, width: size.width, height: size.height, hidden }
    },
    observe: (change: (change: TerminalViewportChange) => void) => {
      onChange = change
      return () => {
        onChange = null
      }
    },
    notify: () => {
      const { width, height } = host.getBoundingClientRect()
      if (width <= 0) {
        return
      }
      if (width === laidOut.width && height === laidOut.height) {
        onChange?.('shown')
        return
      }
      laidOut = { width, height }
      onChange?.('resized')
    }
  }
}

function startPageDocument(
  host: HTMLElement,
  receive: (message: Record<string, unknown>) => void,
  start: TerminalDocumentStart,
  viewport: PageViewport
) {
  // Capture errors per mount; another terminal’s reports and native pre-engine failures do not belong to this document.
  const capturedEngineErrors: string[] = []
  return createTerminalDocument({
    capturedEngineErrors: () => capturedEngineErrors,

    root: host,

    postToHost: receive,

    // Install a removable listener without replacing the app’s window.onerror.
    installErrorReporter: (report) => {
      const errorListener = (event: ErrorEvent) => {
        // Ignore unrelated browser notices without an error object; before ready they would falsely mark this terminal fatal.
        if (!event.error) {
          return
        }
        report(event.message, event.filename, event.lineno, event.colno, event.error)
      }
      window.addEventListener('error', errorListener)
      return () => window.removeEventListener('error', errorListener)
    },

    // Paint the terminal host only; changing html/body would recolor the app after unmount.
    paintDocumentBackground: (background) => {
      host.style.background = background
    },

    // The handle carries page transport; shell message events belong to the app bridge.
    installHostTransport: () => () => {},

    hasEngine: () => true,

    start: () => start,

    viewportRect: viewport.rect,

    observeViewport: viewport.observe,

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shape is xterm's own, except that `getCell` takes back the cell xterm allocated and the document declares only the members it reads on one.
    createTerminal: (options) => new Terminal(options) as unknown as TerminalDocumentTerminal,
    createUnicode11Addon: () => new Unicode11Addon(),
    createWebglAddon: () =>
      createPageWebglAddon((reason) =>
        receive({
          type: 'log',
          tag: '[fit]webgl-unavailable',
          payload: { renderer: 'dom', message: reason }
        })
      )
  })
}
