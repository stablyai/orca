import { Terminal } from '@xterm/xterm'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import type { TerminalDocumentWebglAddon } from './document/document-terminal-shape'
import { TERMINAL_DOCUMENT_ELEMENT_STYLE, TERMINAL_DOCUMENT_MARKUP } from './terminal-webview-html'
import { scopeStyleToHost } from './terminal-webview-html/document-style-scoping'
import { XTERM_ENGINE_CSS } from './terminal-webview-engine-css.generated'
import type { TerminalWebViewCommand } from './terminal-webview-messages'

/**
 * The terminal document, mounted in the page instead of in a WebView.
 *
 * Same program: the modules the WebView's script is generated from, started here in the order the
 * generator emits them. What the WebView's HTML gave them — the stylesheet, the elements they read
 * by id, the engine on `window` and a `postMessage` back to React Native — this supplies instead,
 * through the six scope seams and the host's own element.
 *
 * Ruling 20 is what makes a remount work. ES module bodies run once per page, so the second mount
 * re-imports nothing: every element read, listener and reporter install lives in a start function,
 * and this runs that sequence per mount against the markup it has just replanted. `dispose` takes
 * back the three that outlive the host element.
 *
 * The import is still dynamic, because the page bundle must not carry the document into every
 * route that never opens a terminal.
 */

export type TerminalWebDocument = {
  /** Hands one host command to the document, as `postMessage` does inside the WebView. */
  send: (command: TerminalWebViewCommand & { id: number }) => void
  dispose: () => void
  /**
   * Settles when the document is live, or rejects with what stopped it.
   *
   * The handle itself is returned before this: the document is reached by a dynamic import, and a
   * caller that had to await the import to get a handle would have nothing to dispose while the
   * import was in flight. That is not a corner — a slow chunk is what the readiness watchdog is
   * for, and the overlay's Reload is what ruling 20 names as the way out of it.
   *
   * A mount disposed before its import landed resolves rather than rejecting. Nothing failed:
   * the caller asked for the terminal and then asked for it to go away, and the chunk arriving
   * afterwards is not an error to report. The caller learns which it got from `dispose` being
   * the thing it called, not from this.
   */
  ready: Promise<void>
}

const STYLE_ELEMENT_ID = 'orca-terminal-document-style'

/** The class the host carries, and the prefix every injected rule is held under. */
const HOST_CLASS = 'orca-terminal-document-host'

/**
 * The stylesheet, planted in the head once per page and reaching only inside the host.
 *
 * `<style>` rather than a constructed sheet or inline attributes: the document's own rules and
 * xterm's are written against ids and classes, and the document reads its elements with
 * `document.getElementById`, which a shadow root would break.
 *
 * What is planted is not what the WebView's `<head>` carries. The document-level rules are left
 * behind entirely and every remaining selector is prefixed with the host's class, so nothing here
 * can match an element the terminal does not own. That is also what makes leaving the sheet in
 * the head after unmount the right trade: it matches nothing once the host has dropped the class,
 * the next mount wants it back, and re-parsing 11 KiB per mount is all removing it would buy.
 * Two terminals at once is not the case — `document-scope` is a module singleton, so there is one
 * scope per page and `mount` refuses a second live document rather than letting the two share it.
 */
function ensureDocumentStyle() {
  if (document.getElementById(STYLE_ELEMENT_ID)) {
    return
  }
  const style = document.createElement('style')
  style.id = STYLE_ELEMENT_ID
  const prefix = `.${HOST_CLASS}`
  const engine = scopeStyleToHost(XTERM_ENGINE_CSS, prefix)
  style.textContent = `${engine}\n${scopeStyleToHost(TERMINAL_DOCUMENT_ELEMENT_STYLE, prefix)}`
  document.head.appendChild(style)
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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the addon's public surface is `dispose`, which the document's shape names; the two optional members it also reads are absent here and guarded at every call.
    return new WebglAddon() as unknown as TerminalDocumentWebglAddon
  } catch (error) {
    onFallback(error instanceof Error ? error.message : String(error))
    return null
  }
}

/**
 * Which document is live, if any: one per page, because there is one scope per page.
 *
 * `document-scope` is a module singleton and every module reads it, so a second mount while the
 * first is up would not be a second terminal: both would drive the same fields, the same elements
 * and the same start sequence. The component mounts and disposes in one effect and cannot reach
 * this state, which is exactly why the refusal is named rather than left to surface as two
 * terminals writing over each other.
 *
 * A token per mount rather than the host element or the host's class. Two mounts can be handed
 * the same element — the page remounts a terminal into a host React has reused — so an element is
 * not an identity, and the class says only that *some* document is using this host. The token is
 * what each handle holds, and it is what `dispose` checks before it touches anything shared.
 */
let liveDocument: symbol | null = null

/** What a mount has built so far, which is nothing until its import resolves. */
type StartedDocument = {
  modules: typeof import('./document/page-document-modules')
  onWindowResize: () => void
}

/**
 * The document, mounted. The handle comes back before the document exists.
 *
 * Synchronous on purpose. The modules arrive through a dynamic import, and the caller's cleanup
 * can run while that import is still in flight — a slow chunk, a cold cache, a tab that was
 * backgrounded. A caller that had to await the import to get a handle would have nothing to
 * dispose in that window, and the claim below would outlive the mount that made it: the next
 * mount, the one the error overlay's Reload asks for, would be refused as a second document and
 * the terminal would never come back. So the claim and the handle are made here, together, and
 * `dispose` answers for whichever state the mount is in when it is called.
 */
export function mountTerminalWebDocument(
  host: HTMLElement,
  receive: (message: Record<string, unknown>) => void
): TerminalWebDocument {
  if (liveDocument) {
    throw new Error('the terminal document is already mounted on this page')
  }
  const token = Symbol('orca terminal document')
  liveDocument = token
  let started: StartedDocument | null = null
  /**
   * Gives the page back, and only if it is still this mount's to give.
   *
   * The check covers the element too, not just the claim. Emptying a host and taking its class
   * off are what make the terminal disappear, so a release that skipped the claim but did those
   * anyway would blank the terminal a later mount has on the screen. One rule, inside the thing
   * it governs, rather than at each caller.
   */
  const release = () => {
    if (liveDocument !== token) {
      return
    }
    liveDocument = null
    host.innerHTML = ''
    // The sheet stays in the head; the class does not, so every rule in it matches nothing
    // again the moment the terminal is gone.
    host.classList.remove(HOST_CLASS)
  }

  try {
    ensureDocumentStyle()
    host.classList.add(HOST_CLASS)
    host.innerHTML = TERMINAL_DOCUMENT_MARKUP
    // The WebView's `<head>` declares this before anything runs, and the document's error
    // reporter reads it unguarded. Without it the first report throws inside `window.onerror`.
    window.__engineErrors = []
  } catch (error) {
    // The claim is made before this runs, so it has to come back if the planting fails.
    release()
    throw error
  }

  // Adopted by the build itself, in the same turn as the start sequence and the listener it adds,
  // rather than when this promise settles. A `.then` runs a microtask later, and a dispose in
  // between would find nothing started, skip the teardown and hand the page back with the
  // document still running on it.
  const ready = buildTerminalWebDocument(host, receive, token, (built) => {
    started = built
  }).catch((error: unknown) => {
    // The import failed, so nothing was started and the page has to go back — the overlay's
    // Reload is a second mount and it must be allowed to make one. A later mount may already
    // hold the page, which `release` answers for.
    release()
    throw error
  })

  return {
    send: (command) => {
      started?.modules.handleMsg(command)
    },
    dispose: () => {
      // Once, and only by the document that is live. A handle outlives what it built — the
      // component holds one in a ref and React may run a cleanup after a later mount has already
      // started — so a second call, or a call from a handle whose document has been replaced,
      // would tear down the terminal that is on the screen now. Everything below this line is
      // shared: the scope, the module sequences, the `window.__engineErrors` array.
      if (liveDocument !== token) {
        return
      }
      liveDocument = null
      if (started) {
        teardownStartedDocument(started)
      }
      // Dropped, not just torn down. `send` reads this, and the modules it names are the page's one
      // singleton — so a handle that kept them would route a command into whatever document is
      // live next, which is the mount that replaced this one.
      started = null
      host.innerHTML = ''
      host.classList.remove(HOST_CLASS)
    },
    ready
  }
}

/** Undoes a document that did start: its listener, its module sequence and its terminals. */
function teardownStartedDocument({ modules, onWindowResize }: StartedDocument) {
  window.removeEventListener('resize', onWindowResize)
  modules.stopPageDocumentModules()
  const { scope } = modules
  // Both terminals, because a swap that never committed leaves two. `beginTerminalSurfaceSwap`
  // opens a hidden replacement and `commitTerminalSurfaceSwap` disposes the one it replaced; an
  // unmount between the two leaves the committed terminal live with nothing pointing at it. They
  // are the same object whenever no swap is open, so the pair is deduplicated.
  for (const terminal of new Set([scope.term, scope.committedTerm])) {
    try {
      terminal?.dispose()
    } catch {}
  }
  scope.term = null
  scope.committedTerm = null
}

/**
 * Builds and starts the document, and hands it to `adopt` — or returns having done neither.
 *
 * The token is read again the instant the import lands, before anything below it runs. Every
 * statement after this point writes shared state: the six seams are fields on a module-singleton
 * scope, `startPageDocumentModules` resets that scope and installs listeners, and the resize
 * listener outlives the host. A mount disposed while its chunk was in flight owns none of it, and
 * running the body anyway would plant its elements' listeners into a page a later mount is using
 * and reset that mount's scope out from under it. Checking only when this resolves is too late:
 * by then the writes have happened and the caller can do nothing but discard the result.
 *
 * `adopt` rather than a return value for the same reason: what it hands over is what undoes all of
 * that, and the caller has to be holding it before this function's turn ends.
 */
async function buildTerminalWebDocument(
  host: HTMLElement,
  receive: (message: Record<string, unknown>) => void,
  token: symbol,
  adopt: (built: StartedDocument) => void
): Promise<void> {
  const documentModules = await import('./document/page-document-modules')
  if (liveDocument !== token) {
    return
  }
  const { scope } = documentModules

  // Ruling 19 reaches `window.onerror` too: the WebView's document owns its page and may take
  // that handler, but this one is a guest. An `error` listener reports the same failures without
  // displacing whatever the page installed, and it hands back its own removal so `stopHostNotify`
  // takes it off with everything else.
  scope.installErrorReporter = (report) => {
    const errorListener = (event: ErrorEvent) => {
      report(event.message, event.filename, event.lineno, event.colno, event.error)
    }
    window.addEventListener('error', errorListener)
    return () => window.removeEventListener('error', errorListener)
  }

  // Ruling 19 again, for colour: inside the WebView the terminal's theme is the page's own
  // background and the document paints `html` and `body` with it. Here those belong to the
  // application, and a repaint would outlive the terminal, so the host element takes it instead —
  // it is the element the grid sits on, which is what the paint was for.
  scope.paintDocumentBackground = (background) => {
    host.style.background = background
  }

  scope.postToHost = receive
  scope.createTerminal = (options) =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: xterm's own Terminal is the engine the document was written against; its options are declared optional where the document's shape declares them present, which is the only difference.
    new Terminal(options) as unknown as ReturnType<typeof scope.createTerminal>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the addon's public surface is `dispose`, which the document's shape names; the two optional members it also reads are absent here and guarded there.
  scope.createUnicode11Addon = () => new Unicode11Addon() as unknown as TerminalDocumentWebglAddon
  scope.createWebglAddon = () =>
    createPageWebglAddon((reason) =>
      receive({
        type: 'log',
        tag: '[fit]webgl-unavailable',
        payload: { renderer: 'dom', message: reason }
      })
    )

  // Now the document itself, with every seam already in place.
  documentModules.startPageDocumentModules()

  // `message-bridge` is not imported (ruling 19), so its one non-bridge duty is re-armed here:
  // a viewport change has to re-fit, or opening the keyboard leaves the terminal at the old scale.
  const onWindowResize = () => {
    documentModules.applyFitScale('window-resize')
    documentModules.adjustRowsForViewport()
    documentModules.repositionOverlay()
    documentModules.clampPan()
    documentModules.updateTransform()
  }
  window.addEventListener('resize', onWindowResize)

  adopt({ modules: documentModules, onWindowResize })
}
