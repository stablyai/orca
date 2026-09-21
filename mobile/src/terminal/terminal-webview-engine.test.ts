// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Script } from 'node:vm'
import { parse } from 'acorn'
import { describe, expect, it, vi } from 'vitest'
import { XTERM_ENGINE_CSS } from './terminal-webview-engine-css.generated'
import { XTERM_ENGINE_JS } from './terminal-webview-engine.generated'
import { createTerminalDocumentScope } from './document/document-scope'
import { attachWebglAddon, startWebglRecovery } from './document/webgl-recovery'
import {
  documentModuleSource,
  documentSourceText
} from './document/document-module-source.test-support'
import { XTERM_HTML } from './terminal-webview-html'

// The document's own source, so a rule about what the document does is read where it is written.
const terminalHtmlSource = documentSourceText()

function createWebglRecoveryHarness(failSecondAttach = false) {
  const timers: Array<() => void> = []
  const addons: Array<{
    clearTextureAtlas: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
    fireContextLoss: () => void
  }> = []
  const term = {
    rows: 24,
    // The theme path writes these two, which is how a case reads that it ran.
    options: { theme: {}, minimumContrastRatio: 0, fontSize: 13 },
    refresh: vi.fn(),
    loadAddon: vi.fn(() => {
      if (failSecondAttach && addons.length === 2) {
        throw new Error('retry unavailable')
      }
    })
  }
  function WebglAddon() {
    let contextLoss = () => {}
    const addon = {
      clearTextureAtlas: vi.fn(),
      dispose: vi.fn(),
      fireContextLoss: () => contextLoss()
    }
    addons.push(addon)
    return Object.assign(addon, {
      onContextLoss: (listener: () => void) => {
        contextLoss = listener
      }
    })
  }
  const logged: Record<string, unknown>[] = []
  const terminalThemeInput = { mode: 'dark' }
  // The recovery's own timer, held rather than run: every case decides when the retry fires.
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback: TimerHandler) => {
    if (typeof callback === 'function') {
      timers.push(() => {
        callback()
      })
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the document holds this only to clear it, and nothing here clears a timer.
    return timers.length as unknown as ReturnType<typeof setTimeout>
  })
  const scope = createTerminalDocumentScope({
    createWebglAddon: () => WebglAddon(),
    postToHost: (message) => logged.push(message)
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the double implements the members the recovery path reaches, which is what each case asserts about.
  scope.term = term as unknown as typeof scope.term
  scope.terminalGeneration = 1
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the recovery only re-applies this value through the theme path; its shape is that path's own input.
  scope.terminalThemeInput = terminalThemeInput as unknown as typeof scope.terminalThemeInput
  startWebglRecovery(scope)
  attachWebglAddon(scope, true)
  return {
    addons,
    // The theme is re-applied through the document's own path, which is observable on the terminal
    // rather than through a spy on the function.
    appliedThemes: () => term.options.theme,
    fireVisibilityChange: () => {
      document.dispatchEvent(new Event('visibilitychange'))
    },
    logged,
    scope,
    term,
    terminalThemeInput,
    timers
  }
}

describe('terminal WebView bundled engine', () => {
  it('keeps the assembled terminal HTML free of external engine URLs', () => {
    expect(XTERM_HTML).not.toMatch(/\bhttps?:\/\//)
    expect(XTERM_HTML).not.toContain('cdn.jsdelivr.net')
    expect(XTERM_HTML).not.toContain('<script src=')
    expect(XTERM_HTML).not.toContain('rel="stylesheet" href=')
  })

  it('parses the bundled engine at the Chrome 74 syntax floor', () => {
    expect(() => parse(XTERM_ENGINE_JS, { ecmaVersion: 2019 })).not.toThrow()
  })

  // Why: the context deliberately omits WeakRef (Chrome 84+) / structuredClone
  // (Chrome 98+) and supplies an Element without replaceChildren (Chrome 86+) —
  // the engine must evaluate on older WebViews via its own guarded runtime shims,
  // which are the linchpin of the old-WebView support (esbuild lowers syntax only).
  it('exposes the xterm globals and installs the old-WebView runtime shims', () => {
    const window: Record<string, unknown> = {}
    class ElementStub {}
    const context = {
      window,
      self: window,
      document: {},
      Element: ElementStub,
      navigator: {
        platform: 'Linux armv8l',
        userAgent: 'Mozilla/5.0 Chrome/74.0.3729.157'
      },
      console,
      setTimeout,
      clearTimeout,
      queueMicrotask,
      URL
    }

    new Script(XTERM_ENGINE_JS).runInNewContext(context)

    expect(window).toMatchObject({
      Terminal: expect.any(Function),
      Unicode11Addon: { Unicode11Addon: expect.any(Function) },
      WebglAddon: { WebglAddon: expect.any(Function) }
    })

    const weakRef = window.WeakRef as (new (target: unknown) => { deref(): unknown }) | undefined
    expect(typeof weakRef).toBe('function')
    const token = {}
    expect(new weakRef!(token).deref()).toBe(token)
    expect(typeof window.structuredClone).toBe('function')
    expect(typeof (ElementStub.prototype as { replaceChildren?: unknown }).replaceChildren).toBe(
      'function'
    )
  })

  it('keeps the bundled engine from breaking out of its inline script/style tags', () => {
    // Why: the engine JS/CSS are inlined into <script>/<style> blocks. </script
    // and </style are neutralized at build time; the tokenizer-escape openers that
    // could swallow the rest of the document must also be absent from the bundle.
    expect(XTERM_ENGINE_JS).not.toMatch(/<\/script/i)
    expect(XTERM_ENGINE_JS).not.toMatch(/<script/i)
    expect(XTERM_ENGINE_JS).not.toContain('<!--')
    expect(XTERM_ENGINE_CSS).not.toMatch(/<\/style/i)
  })

  it('reports WebView message handler failures instead of swallowing them', () => {
    const start = terminalHtmlSource.indexOf('function handleIncomingMessage')
    // Bounded by the next declaration in the same module: ruling 24 took the resize listener out
    // of the bridge, so the handler is followed by the start that installs the transport.
    const end = terminalHtmlSource.indexOf('function startMessageBridge', start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    const handlerSource = terminalHtmlSource.slice(start, end)

    expect(handlerSource).toContain('reportEngineError(')
    expect(handlerSource).toContain("'terminal init failed'")
    expect(handlerSource).toContain("'terminal message failed'")
    expect(handlerSource).not.toContain('catch(ex) {}')
  })

  it('classifies runtime errors by a document-scoped ever-ready latch', () => {
    // Why: init() flips `ready` false on every re-init (live width reflow keeps the
    // old surface visible meanwhile), so the fatal default and the init-catch must
    // key off `everReady` — otherwise a transient reflow error blanks a live
    // terminal behind the fatal overlay. The latch stays set for the document.
    // Ruling 21: the latch's initial value is in the scope factory, not in a parse-time write.
    expect(terminalHtmlSource).toContain('everReady: false,')
    expect(terminalHtmlSource).toContain('scope.everReady = true')
    expect(terminalHtmlSource).toContain('fatal === undefined ? !scope.everReady : !!fatal')
    expect(terminalHtmlSource).toContain("msg && msg.type === 'init' && !scope.everReady")
    expect(terminalHtmlSource).not.toMatch(/fatal === void 0 \? !scope\.ready\b/)
  })

  it('bounds error capture and non-fatal reporting on a degraded engine', () => {
    // Why: a constructed-but-broken engine can throw per render frame; both
    // onerror capture sites must cap the buffer and non-fatal notifies must
    // stop flooding RN while fatal reports always emit.
    // Both sites: the document's own reporter, and the shell's inline handler that catches what
    // fails before the document has run at all.
    // `dirname`, not the module URL: a DOM-environment case has no `file:` URL to convert.
    const shell = readFileSync(
      join(import.meta.dirname, 'terminal-webview-html', 'document-shell.ts'),
      'utf8'
    )
    // The shell's buffer is a global because it is older than any document; the document appends to
    // it through the seam, so the two sites now spell the same cap over the same list differently.
    expect(shell).toContain('window.__engineErrors.length < 20')
    expect(terminalHtmlSource).toContain('const captured = scope.capturedEngineErrors()')
    expect(terminalHtmlSource).toContain('if (captured.length < 20) {')
    // The global is read in one place, the seam's own default, and the reporter no longer names it.
    expect(documentModuleSource('host-notify')).not.toContain('window.__engineErrors')
    expect(documentModuleSource('document-host-seams')).toContain(
      'window.__engineErrors = window.__engineErrors ?? []'
    )
    expect(terminalHtmlSource).toContain('nonFatalErrorNotifies > 5')
  })

  it('recreates WebGL once after context loss, then stays on the DOM renderer', () => {
    const { addons, logged, term, timers } = createWebglRecoveryHarness()

    expect(addons).toHaveLength(1)
    addons[0]?.fireContextLoss()
    // The log reaches the host through the notify seam, which is where a real host reads it.
    expect(logged).toContainEqual({
      type: 'log',
      tag: '[fit]webgl-context-loss',
      payload: expect.objectContaining({ retry: true })
    })
    expect(addons[0]?.dispose).toHaveBeenCalledTimes(1)
    expect(term.refresh).toHaveBeenCalledTimes(1)
    expect(timers).toHaveLength(1)

    timers.shift()?.()
    expect(addons).toHaveLength(2)
    expect(addons[1]?.clearTextureAtlas).toHaveBeenCalledTimes(1)
    expect(term.refresh).toHaveBeenCalledTimes(2)
    addons[1]?.fireContextLoss()
    expect(addons[1]?.dispose).toHaveBeenCalledTimes(1)
    expect(term.refresh).toHaveBeenCalledTimes(3)
    expect(timers).toHaveLength(0)
  })

  it('falls back to a refreshed DOM renderer when the delayed WebGL retry fails', () => {
    const { addons, term, timers } = createWebglRecoveryHarness(true)

    addons[0]?.fireContextLoss()
    timers.shift()?.()

    expect(addons).toHaveLength(2)
    expect(addons[1]?.dispose).toHaveBeenCalledTimes(1)
    expect(term.refresh).toHaveBeenCalledTimes(2)
  })

  it('reapplies theme, clears the active atlas, and refreshes when visible', () => {
    const harness = createWebglRecoveryHarness()

    // Hidden: nothing is re-applied, because a repaint of an invisible terminal is wasted. happy-dom
    // reports a visible document, so the hidden arm is the stub and the visible one is the default.
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    harness.fireVisibilityChange()
    expect(harness.term.options.theme).toEqual({})
    vi.restoreAllMocks()

    harness.fireVisibilityChange()
    // The theme is re-applied through the document's own path, read off the terminal it wrote to.
    expect(harness.term.options.theme).not.toEqual({})
    expect(harness.addons[0]?.clearTextureAtlas).toHaveBeenCalledTimes(1)
    expect(harness.term.refresh).toHaveBeenCalledTimes(1)
  })

  it('answers native readiness probes from the live document', () => {
    expect(terminalHtmlSource).toContain("if (msg.type === 'ping')")
    expect(terminalHtmlSource).toContain("notify(scope, { type: 'pong', pingId: msg.id })")
  })
})
