import { paintBottomRowBackdrop } from './bottom-row-backdrop'
import { colors } from '../../theme/mobile-theme'
import type { TerminalDocumentScope, TerminalDocumentTheme } from './document-scope'
import { resolveTerminalMinimumContrastRatio } from '../../../../src/shared/terminal-contrast-correction'

const TERMINAL_BACKGROUND_FALLBACK = colors.terminalBg

// Wire fields stay unknown; older hosts omit the contrast floor.
export type TerminalDocumentThemeMessage =
  | { mode?: unknown; theme?: Record<string, string>; minimumContrastRatio?: unknown }
  | null
  | undefined

export function normalizeTerminalTheme(
  scope: TerminalDocumentScope,
  input: TerminalDocumentThemeMessage
) {
  const source =
    input && typeof input === 'object' && input.theme && typeof input.theme === 'object'
      ? input.theme
      : null
  if (!source) {
    return scope.defaultTheme
  }
  const next: Record<string, string> = {}
  const keys = Object.keys(scope.defaultTheme)
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    if (typeof source[key] === 'string') {
      next[key] = source[key]
    }
  }
  return Object.assign({}, scope.defaultTheme, next)
}

export type TerminalDocumentThemeTarget = {
  options: { theme?: TerminalDocumentTheme; minimumContrastRatio: number }
}

export function applyTerminalTheme(
  scope: TerminalDocumentScope,
  input: TerminalDocumentThemeMessage,
  force = false
) {
  scope.terminalThemeInput = input
  const nextTheme = normalizeTerminalTheme(scope, input)
  const themeChanged = Object.keys(scope.defaultTheme).some(
    (key) => scope.terminalTheme[key] !== nextTheme[key]
  )
  scope.terminalTheme = nextTheme
  const background = scope.terminalTheme.background || TERMINAL_BACKGROUND_FALLBACK
  scope.paintDocumentBackground(background)
  const message = input && typeof input === 'object' ? input : null
  scope.terminalMinimumContrastRatio = resolveTerminalMinimumContrastRatio(
    background,
    message?.mode === 'light' ? 'light' : 'dark',
    message?.minimumContrastRatio
  )
  if (scope.term) {
    // Theme assignment resets OSC palette changes; visibility recovery should repaint without reassignment.
    if (force || themeChanged) {
      scope.term.options.theme = scope.terminalTheme
    }
    if (scope.term.options.minimumContrastRatio !== scope.terminalMinimumContrastRatio) {
      scope.term.options.minimumContrastRatio = scope.terminalMinimumContrastRatio
    }
  }
  paintBottomRowBackdrop(scope)
}
