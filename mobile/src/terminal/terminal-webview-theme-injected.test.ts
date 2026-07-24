import { Script } from 'node:vm'
import { parse } from 'acorn'
import { describe, expect, it } from 'vitest'
import { TERMINAL_WEBVIEW_THEME_JS } from './terminal-webview-theme-injected'

const DARK_FLOOR = 3
const LIGHT_FLOOR = 4.5

// Eval the injected theme JS in a bare context so the declared helpers become
// callable properties on it (mirrors terminal-webview-engine.test.ts).
function loadThemeInjected(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const context: Record<string, unknown> = {
    defaultTheme: { background: '#1a1b26', foreground: '#c0caf5' },
    // terminal-webview-html.ts:292 declares this at script load; applyTerminalTheme reads it.
    terminalTheme: null,
    ...extra
  }
  new Script(TERMINAL_WEBVIEW_THEME_JS).runInNewContext(context)
  return context
}

type ThemeInjectedContext = Record<string, unknown> & {
  applyTerminalTheme: (input: unknown, force?: boolean) => void
}

// Counting accessors: xterm rebuilds its palette on every options.theme write, so the
// value gate is only observable as a write count, never as a final value.
function loadThemeInjectedWithCountingTerm(): {
  context: ThemeInjectedContext
  writes: { theme: number; contrast: number }
} {
  const writes = { theme: 0, contrast: 0 }
  let theme: unknown
  let minimumContrastRatio = 1
  const term = {
    options: {
      get theme() {
        return theme
      },
      set theme(next: unknown) {
        writes.theme += 1
        theme = next
      },
      get minimumContrastRatio() {
        return minimumContrastRatio
      },
      set minimumContrastRatio(next: number) {
        writes.contrast += 1
        minimumContrastRatio = next
      }
    }
  }
  const context = loadThemeInjected({
    term,
    document: {
      documentElement: { style: { background: '' } },
      body: { style: { background: '' } }
    }
  }) as ThemeInjectedContext
  return { context, writes }
}

describe('mobile terminal-webview contrast floor gate', () => {
  it('parses at the Chrome 74 syntax floor', () => {
    expect(() => parse(TERMINAL_WEBVIEW_THEME_JS, { ecmaVersion: 2019 })).not.toThrow()
  })

  it('picks the dark floor for dark composed backgrounds', () => {
    const { resolveTerminalContrastFloor } = loadThemeInjected() as {
      resolveTerminalContrastFloor: (bg: unknown) => number
    }
    for (const bg of ['#1a1b26', '#1e242a', '#282828', '#000000', 'black']) {
      expect(resolveTerminalContrastFloor(bg)).toBe(DARK_FLOOR)
    }
  })

  it('picks the light floor for light composed backgrounds', () => {
    const { resolveTerminalContrastFloor } = loadThemeInjected() as {
      resolveTerminalContrastFloor: (bg: unknown) => number
    }
    for (const bg of ['#ffffff', '#fbf1c7', 'white', 'rgb(240 240 240)']) {
      expect(resolveTerminalContrastFloor(bg)).toBe(LIGHT_FLOOR)
    }
  })

  it('composites transparency over the dark app surface before deciding', () => {
    const { resolveTerminalContrastFloor } = loadThemeInjected() as {
      resolveTerminalContrastFloor: (bg: unknown) => number
    }
    // Fully transparent → app surface (dark) → dark floor.
    expect(resolveTerminalContrastFloor('transparent')).toBe(DARK_FLOOR)
    // Faint white over the dark surface stays dark; opaque-enough white flips light.
    expect(resolveTerminalContrastFloor('rgba(255,255,255,0.15)')).toBe(DARK_FLOOR)
    expect(resolveTerminalContrastFloor('rgba(255,255,255,0.9)')).toBe(LIGHT_FLOOR)
  })

  it('defaults unparseable backgrounds to the dark floor so output never stays invisible', () => {
    const { resolveTerminalContrastFloor } = loadThemeInjected() as {
      resolveTerminalContrastFloor: (bg: unknown) => number
    }
    for (const bg of [undefined, null, '', 'not-a-color', '#12', 42]) {
      expect(resolveTerminalContrastFloor(bg)).toBe(DARK_FLOOR)
    }
  })

  it('writes the resolved floor onto a live terminal when the theme changes', () => {
    const term = { options: { theme: undefined as unknown, minimumContrastRatio: 1 } }
    const context = loadThemeInjected({
      term,
      document: {
        documentElement: { style: { background: '' } },
        body: { style: { background: '' } }
      }
    }) as Record<string, unknown> & { applyTerminalTheme: (input: unknown) => void }

    context.applyTerminalTheme({ theme: { background: '#ffffff' } })
    expect(term.options.minimumContrastRatio).toBe(LIGHT_FLOOR)

    context.applyTerminalTheme({ theme: { background: '#1e242a' } })
    expect(term.options.minimumContrastRatio).toBe(DARK_FLOOR)
  })

  it('does not rewrite an identical palette, but keeps the module theme vars current', () => {
    const { context, writes } = loadThemeInjectedWithCountingTerm()
    const second = { theme: { background: '#1a1b26', foreground: '#c0caf5' } }

    context.applyTerminalTheme({ theme: { background: '#1a1b26', foreground: '#c0caf5' } })
    context.applyTerminalTheme(second)

    expect(writes.theme).toBe(1)
    // terminal-webview-html.ts:713-718 builds the Terminal from these right after an apply.
    expect(context.terminalThemeInput).toBe(second)
    expect(context.terminalTheme).toMatchObject({ background: '#1a1b26' })
  })

  it('rewrites the palette when a color actually changes', () => {
    const { context, writes } = loadThemeInjectedWithCountingTerm()

    context.applyTerminalTheme({ theme: { background: '#1a1b26' } })
    context.applyTerminalTheme({ theme: { background: '#282828' } })

    expect(writes.theme).toBe(2)
  })

  it('rewrites an identical palette when forced by the iOS visibility repaint', () => {
    const { context, writes } = loadThemeInjectedWithCountingTerm()

    context.applyTerminalTheme({ theme: { background: '#1a1b26' } })
    context.applyTerminalTheme({ theme: { background: '#1a1b26' } }, true)

    expect(writes.theme).toBe(2)
  })

  it('does not rewrite the contrast floor when it is unchanged', () => {
    const { context, writes } = loadThemeInjectedWithCountingTerm()

    context.applyTerminalTheme({ theme: { background: '#1a1b26' } })
    context.applyTerminalTheme({ theme: { background: '#282828' } })

    expect(writes.contrast).toBe(1)
  })
})
