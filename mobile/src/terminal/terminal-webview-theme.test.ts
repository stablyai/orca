// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { createTerminalDocumentScope } from './document/document-scope'
import { applyTerminalTheme } from './document/terminal-theme'
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

function loadThemeApplier(
  term: TerminalDocumentThemeTarget
): (input: TerminalDocumentThemeMessage) => void {
  const scope = themeScope(term)
  return (input: TerminalDocumentThemeMessage) => applyTerminalTheme(scope, input)
}

describe('mobile terminal-webview contrast floor gate', () => {
  it('writes the resolved floor onto a live terminal when the theme changes', () => {
    const term: TerminalDocumentThemeTarget = { options: { minimumContrastRatio: 1 } }
    const applyTerminalTheme = loadThemeApplier(term)

    applyTerminalTheme({ theme: { background: '#ffffff' } })
    expect(term.options.minimumContrastRatio).toBe(LIGHT_FLOOR)

    applyTerminalTheme({ theme: { background: '#1e242a' } })
    expect(term.options.minimumContrastRatio).toBe(DARK_FLOOR)
  })

  it('composites a translucent background over the published app surface', () => {
    const term: TerminalDocumentThemeTarget = { options: { minimumContrastRatio: 1 } }
    const applyTerminalTheme = loadThemeApplier(term)
    const background = 'rgba(255, 255, 255, 0.15)'

    applyTerminalTheme({ mode: 'light', theme: { background } })
    expect(term.options.minimumContrastRatio).toBe(LIGHT_FLOOR)

    applyTerminalTheme({ mode: 'dark', theme: { background } })
    expect(term.options.minimumContrastRatio).toBe(DARK_FLOOR)

    applyTerminalTheme({ theme: { background } })
    expect(term.options.minimumContrastRatio).toBe(DARK_FLOOR)
  })

  // Published desktop overrides, including disabled contrast, must win so the same session renders consistently.
  it('uses the published floor instead of the luminance gate', () => {
    const term = { options: { minimumContrastRatio: 0 } }
    loadThemeApplier(term)({ theme: { background: '#1e242a' }, minimumContrastRatio: 1 })
    expect(term.options.minimumContrastRatio).toBe(1)
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
