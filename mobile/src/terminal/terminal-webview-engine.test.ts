// @vitest-environment happy-dom
import { Script } from 'node:vm'
import { parse } from 'acorn'
import { describe, expect, it, vi } from 'vitest'
import { XTERM_ENGINE_CSS } from './terminal-webview-engine-css.generated'
import { XTERM_ENGINE_JS } from './terminal-webview-engine.generated'
import { createTerminalDocumentScope } from './document/document-scope'
import { attachWebglAddon, startWebglRecovery } from './document/webgl-recovery'
import { XTERM_HTML } from './terminal-webview-html'

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
})
