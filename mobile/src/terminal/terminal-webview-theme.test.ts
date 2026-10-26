// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { createTerminalDocumentScope } from './document/document-scope'
import { applyTerminalTheme, resolveTerminalContrastFloor } from './document/terminal-theme'
import type {
  TerminalDocumentThemeMessage,
  TerminalDocumentThemeTarget
} from './document/terminal-theme'

const DARK_FLOOR = 3
const LIGHT_FLOOR = 4.5

// Use minimal theme state; background paint is inert because assertions measure contrast, not rendering.
function themeScope(term: TerminalDocumentThemeTarget | null = null) {
  const scope = createTerminalDocumentScope({ paintDocumentBackground: () => {} })
  scope.defaultTheme = { background: '#1a1b26', foreground: '#c0caf5' }
  if (term) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the target is the members `applyTerminalTheme` writes, which is what each case then reads back.
    scope.term = term as unknown as typeof scope.term
  }
  return scope
}

function loadContrastFloorResolver(): (bg: unknown) => number {
  return (bg: unknown) => resolveTerminalContrastFloor(bg)
}

function loadThemeApplier(
  term: TerminalDocumentThemeTarget
): (input: TerminalDocumentThemeMessage) => void {
  const scope = themeScope(term)
  return (input: TerminalDocumentThemeMessage) => applyTerminalTheme(scope, input)
}

describe('mobile terminal-webview contrast floor gate', () => {
  it('picks the dark floor for dark composed backgrounds', () => {
    const resolveTerminalContrastFloor = loadContrastFloorResolver()
    for (const bg of ['#1a1b26', '#1e242a', '#282828', '#000000', 'black']) {
      expect(resolveTerminalContrastFloor(bg)).toBe(DARK_FLOOR)
    }
  })

  it('picks the light floor for light composed backgrounds', () => {
    const resolveTerminalContrastFloor = loadContrastFloorResolver()
    for (const bg of ['#ffffff', '#fbf1c7', 'white', 'rgb(240 240 240)']) {
      expect(resolveTerminalContrastFloor(bg)).toBe(LIGHT_FLOOR)
    }
  })

  it('composites transparency over the dark app surface before deciding', () => {
    const resolveTerminalContrastFloor = loadContrastFloorResolver()
    expect(resolveTerminalContrastFloor('transparent')).toBe(DARK_FLOOR)
    expect(resolveTerminalContrastFloor('rgba(255,255,255,0.15)')).toBe(DARK_FLOOR)
    expect(resolveTerminalContrastFloor('rgba(255,255,255,0.9)')).toBe(LIGHT_FLOOR)
  })

  it('defaults unparseable backgrounds to the dark floor so output never stays invisible', () => {
    const resolveTerminalContrastFloor = loadContrastFloorResolver()
    for (const bg of [undefined, null, '', 'not-a-color', '#12', 42]) {
      expect(resolveTerminalContrastFloor(bg)).toBe(DARK_FLOOR)
    }
  })

  it('writes the resolved floor onto a live terminal when the theme changes', () => {
    const term: TerminalDocumentThemeTarget = { options: { minimumContrastRatio: 1 } }
    const applyTerminalTheme = loadThemeApplier(term)

    applyTerminalTheme({ theme: { background: '#ffffff' } })
    expect(term.options.minimumContrastRatio).toBe(LIGHT_FLOOR)

    applyTerminalTheme({ theme: { background: '#1e242a' } })
    expect(term.options.minimumContrastRatio).toBe(DARK_FLOOR)
  })

  // Published desktop overrides, including disabled contrast, must win so the same session renders consistently.
  describe('published desktop override', () => {
    function applyOn(term: TerminalDocumentThemeTarget, input: TerminalDocumentThemeMessage): void {
      loadThemeApplier(term)(input)
    }

    it('uses the published floor instead of the luminance gate', () => {
      const term = { options: { minimumContrastRatio: 0 } }
      applyOn(term, { theme: { background: '#1e242a' }, minimumContrastRatio: 1 })
      expect(term.options.minimumContrastRatio).toBe(1)
    })

    it("clamps a published floor to xterm's 1-21 window", () => {
      const term = { options: { minimumContrastRatio: 0 } }
      applyOn(term, { theme: { background: '#1e242a' }, minimumContrastRatio: 99 })
      expect(term.options.minimumContrastRatio).toBe(21)
      applyOn(term, { theme: { background: '#1e242a' }, minimumContrastRatio: 0 })
      expect(term.options.minimumContrastRatio).toBe(1)
    })

    it('falls back to the luminance gate for an older host that omits the field', () => {
      const term = { options: { minimumContrastRatio: 0 } }
      for (const published of [undefined, null, 'off', Number.NaN]) {
        applyOn(term, { theme: { background: '#1e242a' }, minimumContrastRatio: published })
        expect(term.options.minimumContrastRatio).toBe(DARK_FLOOR)
        applyOn(term, { theme: { background: '#ffffff' }, minimumContrastRatio: published })
        expect(term.options.minimumContrastRatio).toBe(LIGHT_FLOOR)
      }
    })
  })
})

describe('mobile terminal theme idempotence', () => {
  function countingThemeScope() {
    const term: TerminalDocumentThemeTarget = { options: { minimumContrastRatio: DARK_FLOOR } }
    const scope = themeScope(term)
    scope.terminalTheme = { ...scope.defaultTheme }
    term.options.theme = scope.terminalTheme
    const themeWrite = vi.fn()
    const contrastWrite = vi.fn()
    let theme = term.options.theme
    let contrast = term.options.minimumContrastRatio
    Object.defineProperty(term.options, 'theme', {
      get: () => theme,
      set: (next) => {
        themeWrite(next)
        theme = next
      },
      configurable: true
    })
    Object.defineProperty(term.options, 'minimumContrastRatio', {
      get: () => contrast,
      set: (next) => {
        contrastWrite(next)
        contrast = next
      },
      configurable: true
    })
    return { scope, term, themeWrite, contrastWrite }
  }

  it('preserves a live palette through repeated equal normalized host themes', () => {
    const { scope, term, themeWrite, contrastWrite } = countingThemeScope()
    const livePalette = term.options.theme
    const second = { theme: { foreground: '#c0caf5', background: '#1a1b26', ignored: '#ffffff' } }
    applyTerminalTheme(scope, { theme: { background: '#1a1b26' } })
    applyTerminalTheme(scope, second)
    expect(themeWrite).not.toHaveBeenCalled()
    expect(contrastWrite).not.toHaveBeenCalled()
    expect(term.options.theme).toBe(livePalette)
    expect(scope.terminalThemeInput).toBe(second)
  })

  it('changes palette and published contrast independently', () => {
    const { scope, themeWrite, contrastWrite } = countingThemeScope()
    applyTerminalTheme(scope, { theme: { background: '#282828' } })
    expect(themeWrite).toHaveBeenCalledTimes(1)
    expect(contrastWrite).not.toHaveBeenCalled()
    applyTerminalTheme(scope, { theme: { background: '#282828' }, minimumContrastRatio: 1 })
    expect(themeWrite).toHaveBeenCalledTimes(1)
    expect(contrastWrite).toHaveBeenCalledExactlyOnceWith(1)
  })

  it('forces an identical palette for visibility recovery', () => {
    const { scope, themeWrite } = countingThemeScope()
    applyTerminalTheme(scope, { theme: { ...scope.defaultTheme } }, true)
    expect(themeWrite).toHaveBeenCalledTimes(1)
  })

  it('retains theme and published contrast before terminal construction', () => {
    const scope = themeScope()
    applyTerminalTheme(scope, { theme: { background: '#282828' }, minimumContrastRatio: 1 })
    expect(scope.terminalTheme.background).toBe('#282828')
    expect(scope.terminalMinimumContrastRatio).toBe(1)
  })
})
