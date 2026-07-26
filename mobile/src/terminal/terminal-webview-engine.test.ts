import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import { parse } from 'acorn'
import { describe, expect, it, vi } from 'vitest'
import { XTERM_ENGINE_CSS, XTERM_ENGINE_JS } from './terminal-webview-engine.generated'
import { XTERM_HTML } from './terminal-webview-html'
import { TERMINAL_WEBGL_RECOVERY_JS } from './terminal-webview-webgl-recovery-injected'

const terminalHtmlSource = readFileSync(
  new URL('./terminal-webview-html.ts', import.meta.url),
  'utf8'
)

function createWebglRecoveryHarness(failSecondAttach = false) {
  const variablesStart = terminalHtmlSource.indexOf('  var webglAddon = null;')
  const variablesEnd = terminalHtmlSource.indexOf(
    '\n',
    terminalHtmlSource.indexOf('  var webglRecoveryTimer = null;')
  )
  expect(variablesStart).toBeGreaterThanOrEqual(0)
  expect(variablesEnd).toBeGreaterThan(variablesStart)

  const timers: Array<() => void> = []
  const addons: Array<{
    clearTextureAtlas: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
    fireContextLoss: () => void
  }> = []
  const term = {
    rows: 24,
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
  let visibilityChange = () => {}
  const document = {
    addEventListener: vi.fn((eventName: string, listener: () => void) => {
      if (eventName === 'visibilitychange') {
        visibilityChange = listener
      }
    }),
    visibilityState: 'hidden'
  }
  const applyTerminalTheme = vi.fn()
  const flog = vi.fn()
  const terminalThemeInput = { mode: 'dark' }
  const context = {
    applyTerminalTheme,
    clearTimeout: vi.fn(),
    document,
    flog,
    setTimeout: (callback: () => void) => {
      timers.push(callback)
      return timers.length
    },
    term,
    terminalGeneration: 1,
    terminalThemeInput,
    window: { WebglAddon: { WebglAddon } }
  }
  new Script(`${terminalHtmlSource.slice(variablesStart, variablesEnd)}
${TERMINAL_WEBGL_RECOVERY_JS}
attachWebglAddon(true);`).runInNewContext(context)
  return {
    addons,
    applyTerminalTheme,
    document,
    fireVisibilityChange: () => visibilityChange(),
    flog,
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
    const end = terminalHtmlSource.indexOf("window.addEventListener('resize'", start)
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
    expect(terminalHtmlSource).toContain('var everReady = false;')
    expect(terminalHtmlSource).toContain('everReady = true;')
    expect(terminalHtmlSource).toContain('fatal === undefined ? !everReady : !!fatal')
    expect(terminalHtmlSource).toContain("msg.type === 'init' && !everReady")
    expect(terminalHtmlSource).not.toMatch(/fatal === undefined \? !ready\b/)
  })

  it('bounds error capture and non-fatal reporting on a degraded engine', () => {
    // Why: a constructed-but-broken engine can throw per render frame; both
    // onerror capture sites must cap the buffer and non-fatal notifies must
    // stop flooding RN while fatal reports always emit.
    const capSites = terminalHtmlSource.match(/__engineErrors\.length < 20/g) ?? []
    expect(capSites.length).toBe(2)
    expect(terminalHtmlSource).toContain('nonFatalErrorNotifies > 5')
  })

  it('recreates WebGL once after context loss, then stays on the DOM renderer', () => {
    const { addons, flog, term, timers } = createWebglRecoveryHarness()

    expect(addons).toHaveLength(1)
    addons[0]?.fireContextLoss()
    expect(flog).toHaveBeenCalledWith(
      'webgl-context-loss',
      expect.objectContaining({ retry: true })
    )
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

    harness.fireVisibilityChange()
    expect(harness.applyTerminalTheme).not.toHaveBeenCalled()

    harness.document.visibilityState = 'visible'
    harness.fireVisibilityChange()

    expect(harness.applyTerminalTheme).toHaveBeenCalledWith(harness.terminalThemeInput)
    expect(harness.addons[0]?.clearTextureAtlas).toHaveBeenCalledTimes(1)
    expect(harness.term.refresh).toHaveBeenCalledTimes(1)
  })

  it('answers native readiness probes from the live document', () => {
    expect(terminalHtmlSource).toContain("if (msg.type === 'ping')")
    expect(terminalHtmlSource).toContain("notify({ type: 'pong', pingId: msg.id })")
  })
})
