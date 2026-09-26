import { Terminal } from '@xterm/xterm'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import type { TerminalDocumentTerminal } from './document/document-terminal-shape'
import type { TerminalViewportChange } from './document/document-host-seams'
import { TERMINAL_DOCUMENT_ELEMENT_STYLE, TERMINAL_DOCUMENT_MARKUP } from './terminal-webview-html'
import { scopeStyleToHost } from '../style-scoping/document-style-scoping'
import { XTERM_ENGINE_CSS } from './terminal-webview-engine-css.generated'
import { createTerminalDocument } from './document/create-terminal-document'
import type { TerminalWebViewCommand } from './terminal-webview-messages'

/**
 * The terminal document, mounted in the page instead of in a WebView.
 *
 * Same program: the factory the WebView's script is generated from, called here with the page's
 * own hooks instead of the WebView's window (ruling 22). What the WebView's HTML gave the document
 * — the stylesheet, the elements it reads by id, the engine on `window`, a `postMessage` back to
 * React Native and the frames that arrive on it — this supplies instead, through the ten seams
 * and the host element.
 *
 * A call is a document. Nothing here is shared between two of them and nothing is reset: each call
 * builds its own scope, so a second mount cannot reach the first one's state, and a stale callback
 * from a mount that has gone away reads the scope it closed over rather than the live one.
 */

export type TerminalWebDocument = {
  /** Hands one host command to the document, as a bridge frame does inside the WebView. */
  send: (command: TerminalWebViewCommand & { id: number }) => void
  /** RN laid the host out again: the page's counterpart of the WebView's window resize. */
  notifyViewport: () => void
  dispose: () => void
}

const STYLE_ELEMENT_ID = 'orca-terminal-document-style'

/** The class the host carries, and the prefix every injected rule is held under. */
const HOST_CLASS = 'orca-terminal-document-host'

/**
 * The stylesheet, planted in the head once per page and reaching only inside the host.
 *
 * `<style>` rather than a constructed sheet or inline attributes: the document's own rules and
 * xterm's are written against ids and classes, and this is the cheapest way to carry them.
 *
 * The element reads are no longer what a shadow root would break — `elementInRoot` is a
 * `querySelector` under the host, which a shadow root answers. This sheet is: a rule in the
 * document's head does not cross a shadow boundary, so it would have to move inside each root and
 * be parsed once per host rather than once per page.
 *
 * What is planted is not what the WebView's `<head>` carries. The document-level rules are left
 * behind entirely and every remaining selector is prefixed with the host's class, so nothing here
 * can match an element the terminal does not own. That is also what makes leaving the sheet in
 * the head after unmount the right trade: it matches nothing once the host has dropped the class,
 * the next mount wants it back, and re-parsing 11 KiB per mount is all removing it would buy.
 */
function ensureDocumentStyle() {
  if (document.getElementById(STYLE_ELEMENT_ID)) {
    return
  }
  const style = document.createElement('style')
  style.id = STYLE_ELEMENT_ID
  const prefix = `.${HOST_CLASS}`
  const engine = scopeStyleToHost(XTERM_ENGINE_CSS, prefix)
  const elements = scopeStyleToHost(TERMINAL_DOCUMENT_ELEMENT_STYLE, prefix)
  style.textContent = `${engine}\n${elements}\n${hostFrameStyle(prefix)}`
  document.head.appendChild(style)
}

/**
 * The overlays' frame. In the WebView `position: fixed` is the terminal frame; here it is the
 * page, so they would draw over the header. The host becomes their containing block instead.
 */
function hostFrameStyle(prefix: string) {
  return `${prefix} { position: relative; }
${prefix} #selection-overlay, ${prefix} #scroll-indicator { position: absolute; }`
}

/**
 * The WebGL addon, or null when the browser refuses it.
 *
 * `webgl-recovery` treats null as the DOM renderer, which is the fallback the document already
 * has for a context loss; the page reaches it one step earlier, when the context was never
 * granted at all. The caller is told, because a terminal quietly on the slow renderer is worth a
 * line in the log rather than a silent halving of the drain rate.
 */
function createPageWebglAddon(onFallback: (reason: string) => void) {
  try {
    return new WebglAddon()
  } catch (error) {
    onFallback(error instanceof Error ? error.message : String(error))
    return null
  }
}

/**
 * The document, mounted: style, markup, one call, and the handle that stops it.
 *
 * Synchronous, because the factory is a static import and building a document is a function call.
 * A caller's cleanup can therefore never arrive before there is something to clean up.
 */
export function mountTerminalWebDocument(
  host: HTMLElement,
  receive: (message: Record<string, unknown>) => void
): TerminalWebDocument {
  ensureDocumentStyle()
  host.classList.add(HOST_CLASS)
  host.innerHTML = TERMINAL_DOCUMENT_MARKUP
  const viewport = pageViewport(host)
  const started = startDocumentOrGiveTheHostBack(host, receive, viewport)

  return {
    send: (command) => {
      started.send(command)
    },
    notifyViewport: viewport.notify,
    dispose: () => {
      started.stop()
      host.innerHTML = ''
      // The sheet stays in the head; the class does not, so every rule in it matches nothing
      // again the moment the terminal is gone.
      host.classList.remove(HOST_CLASS)
    }
  }
}

/**
 * The call, and the host given back if it throws.
 *
 * A start that throws is unwound inside the factory, which leaves the document stopped and the
 * page holding this function's own two edits: the markup and the class. Neither has an owner once
 * there is no handle, and the error overlay the caller shows would otherwise sit over a dead
 * terminal's elements, styled by a sheet whose rules the class is still matching.
 */
function startDocumentOrGiveTheHostBack(
  host: HTMLElement,
  receive: (message: Record<string, unknown>) => void,
  viewport: PageViewport
) {
  try {
    return startPageDocument(host, receive, viewport)
  } catch (error) {
    host.innerHTML = ''
    host.classList.remove(HOST_CLASS)
    throw error
  }
}

type PageViewport = ReturnType<typeof pageViewport>

/**
 * The host's box, pushed by RN layout. RN web lays a `display:none` host out as 0x0 and its return
 * as the same box: the size stays the last real one, as a covered WebView's does, and the return is
 * a show rather than a resize. Sizes are the client rect's; RN web's are whole-pixel `offsetWidth`s.
 */
function pageViewport(host: HTMLElement) {
  // Seeded from the host, since RN's first layout can land before this mount exists.
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

/** The eleven seams, as the page answers them. */
function startPageDocument(
  host: HTMLElement,
  receive: (message: Record<string, unknown>) => void,
  viewport: PageViewport
) {
  // Written by this document's own reporter: `startHostNotify` installs it through the seam below,
  // which here is a `window` error listener, and every error it forwards is appended before the
  // report that quotes it. What the page cannot have is the WebView head's half — a buffer open
  // before the engine script runs — because the engine here is a static import of this module. So
  // the buffer is per mount, and a second terminal quotes its own lines rather than the first's.
  const capturedEngineErrors: string[] = []
  return createTerminalDocument({
    capturedEngineErrors: () => capturedEngineErrors,

    // Ruling 24's ninth member: this document's elements are the ones inside this host. Two
    // terminals can be on the page at once — a stack transition keeps the outgoing screen mounted
    // while the incoming one starts — and the markup's ids are the same in both hosts.
    root: host,

    postToHost: receive,

    // Ruling 19 reaches `window.onerror`: the WebView's document owns its page and may take that
    // handler, but this one is a guest. An `error` listener reports the same failures without
    // displacing whatever the page installed, and it hands back its own removal so
    // `stopHostNotify` takes it off with everything else.
    installErrorReporter: (report) => {
      const errorListener = (event: ErrorEvent) => {
        report(event.message, event.filename, event.lineno, event.colno, event.error)
      }
      window.addEventListener('error', errorListener)
      return () => window.removeEventListener('error', errorListener)
    },

    // Ruling 19 again, for colour: inside the WebView the terminal's theme is the page's own
    // background and the document paints `html` and `body` with it. Here those belong to the
    // application, and a repaint would outlive the terminal, so the host element takes it instead —
    // it is the element the grid sits on, which is what the paint was for.
    paintDocumentBackground: (background) => {
      host.style.background = background
    },

    // Ruling 24: the page's transport is the handle this returns. Listening for the shell's own
    // `message` events would take frames that belong to the page's bridge, so nothing is installed
    // and there is nothing to remove.
    installHostTransport: () => () => {},

    // Ruling 24: the WebView reads a global the engine bundle installs, because its script tag can
    // fail. Here the engine is the import above, so it is here or this module did not load.
    hasEngine: () => true,

    // The window here is the whole page, header and dock included; the grid is shown in the host.
    viewportRect: viewport.rect,

    // The host resizes without the window, and RN layout is what says so: the component pushes it.
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
