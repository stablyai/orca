// @vitest-environment happy-dom
import { Script } from 'node:vm'
import { parse } from 'acorn'
import { describe, expect, it, vi } from 'vitest'
import { XTERM_ENGINE_CSS } from './terminal-webview-engine-css.generated'
import { XTERM_ENGINE_JS } from './terminal-webview-engine.generated'
import { createTerminalDocumentScope } from './document/document-scope'
import { attachWebglAddon } from './document/webgl-recovery'
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
  attachWebglAddon(scope, true)
  return {
    addons,
    logged,
    term,
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

  it('answers the mode query OpenCode sends during startup', async () => {
    vi.useFakeTimers()
    const reply = vi.fn()
    const window = {}
    try {
      new Script(
        `${XTERM_ENGINE_JS}; const terminal = new window.Terminal();
        terminal.onData(reply); terminal.write('\\x1b[?1004$p');`
      ).runInNewContext({
        window,
        self: window,
        document: {},
        navigator: { platform: 'Linux', userAgent: 'Chrome/74' },
        structuredClone,
        performance,
        setTimeout,
        clearTimeout,
        queueMicrotask,
        console,
        URL,
        reply
      })
      await vi.runAllTimersAsync()
      expect(reply).toHaveBeenCalledWith('\x1b[?1004;2$y')
    } finally {
      vi.useRealTimers()
    }
  })

  // Omit newer WebView APIs to verify runtime shims; esbuild lowers syntax without polyfilling WeakRef/structuredClone/replaceChildren.
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
    // Inline script/style output must neutralize closing tags and tokenizer openers that could consume the remaining HTML.
    expect(XTERM_ENGINE_JS).not.toMatch(/<\/script/i)
    expect(XTERM_ENGINE_JS).not.toMatch(/<script/i)
    expect(XTERM_ENGINE_JS).not.toContain('<!--')
    expect(XTERM_ENGINE_CSS).not.toMatch(/<\/style/i)
  })

  it('recreates WebGL once after context loss, then stays on the DOM renderer', () => {
    const { addons, logged, term, timers } = createWebglRecoveryHarness()

    expect(addons).toHaveLength(1)
    addons[0]?.fireContextLoss()
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
})
