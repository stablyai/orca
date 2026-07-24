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
    ...extra
  }
  new Script(TERMINAL_WEBVIEW_THEME_JS).runInNewContext(context)
  return context
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
})
