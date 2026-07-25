import { describe, expect, it } from 'vitest'
import { DEFAULT_TERMINAL_THEME, XTERM_HTML, XTERM_WEBVIEW_SOURCE } from './terminal-webview-html'
import { darkColors } from '../theme/mobile-theme'

describe('terminal webview HTML app-chrome defaults', () => {
  it('keeps XTERM_WEBVIEW_SOURCE a stable module constant (no colors import)', async () => {
    expect(XTERM_WEBVIEW_SOURCE).toEqual({ html: XTERM_HTML })
    expect(XTERM_WEBVIEW_SOURCE).toBe(XTERM_WEBVIEW_SOURCE)
    // Module must not import the app palette — source identity must stay stable.
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('./terminal-webview-html.ts', import.meta.url), 'utf8')
    )
    expect(src).not.toMatch(/import\s*\{[^}]*\bcolors\b[^}]*\}\s*from\s*['"][^'"]*mobile-theme['"]/)
  })

  it("defaults CSS custom properties to today's dark palette so a silent document paints identically", () => {
    expect(XTERM_HTML).toContain('--terminal-fallback-bg: #1a1b26')
    expect(XTERM_HTML).toContain('--terminal-scrollbar: #888888')
    expect(XTERM_HTML).toContain('background: var(--terminal-fallback-bg)')
    expect(XTERM_HTML).toContain('background: var(--terminal-scrollbar)')
    expect(darkColors.terminalBg).toBe('#1a1b26')
    expect(darkColors.textSecondary).toBe('#888888')
    expect(DEFAULT_TERMINAL_THEME.background).toBe(darkColors.terminalBg)
    expect(DEFAULT_TERMINAL_THEME.cursorAccent).toBe(darkColors.terminalBg)
  })
})
