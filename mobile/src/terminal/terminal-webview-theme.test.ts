import { Script } from 'node:vm'
import { parse } from 'acorn'
import { describe, expect, it } from 'vitest'
import {
  documentDeclaredFunction,
  documentScopePreamble,
  generatedDocumentModule
} from './document/generated-document-region.test-support'
import type { TerminalDocumentThemeTarget } from './document/terminal-theme'

const themeSource = await generatedDocumentModule('terminal-theme')

const DARK_FLOOR = 3
const LIGHT_FLOOR = 4.5

// Eval the theme block the document carries in a bare context so its declared helpers become
// callable properties on it (mirrors terminal-webview-engine.test.ts). The terminal it drives is
// a scope field in the document, so it is handed in through the scope rather than as a global.
function loadThemeInjected(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const { term, ...globals } = extra
  const context: Record<string, unknown> = { ...globals, hostTerm: term ?? null }
  new Script(
    `${documentScopePreamble()}
scope.defaultTheme = { background: "#1a1b26", foreground: "#c0caf5" };
scope.term = hostTerm;
${themeSource}`
  ).runInNewContext(context)
  return context
}

function loadContrastFloorResolver(): (bg: unknown) => number {
  return documentDeclaredFunction(loadThemeInjected(), 'resolveTerminalContrastFloor')
}

function loadThemeApplier(term: TerminalDocumentThemeTarget): (input: unknown) => void {
  const context = loadThemeInjected({
    term,
    document: {
      documentElement: { style: { background: '' } },
      body: { style: { background: '' } }
    }
  })
  return documentDeclaredFunction(context, 'applyTerminalTheme')
}

describe('mobile terminal-webview contrast floor gate', () => {
  it('parses at the Chrome 74 syntax floor', () => {
    expect(() => parse(themeSource, { ecmaVersion: 2019 })).not.toThrow()
  })

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
    // Fully transparent → app surface (dark) → dark floor.
    expect(resolveTerminalContrastFloor('transparent')).toBe(DARK_FLOOR)
    // Faint white over the dark surface stays dark; opaque-enough white flips light.
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

  // #10754: the desktop user can lower or disable the floor. Mobile mirrors the desktop gate, so the
  // published value has to win here or the same session renders differently on the phone.
  describe('published desktop override', () => {
    function applyOn(term: TerminalDocumentThemeTarget, input: unknown): void {
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
