// @vitest-environment happy-dom
import { Script } from 'node:vm'
import { parse } from 'acorn'
import { describe, expect, it, vi } from 'vitest'
import { XTERM_ENGINE_JS } from '../document/terminal-webview-engine.generated'
describe('terminal WebView bundled engine', () => {
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
})
