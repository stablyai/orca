/**
 * Issue #8797 — Background Opacity + Window Blur have no visible effect on macOS.
 *
 * Root cause (code-level):
 * 1. createMainWindow always paints an opaque solid `backgroundColor`
 *    (`#0a0a0a` / `#ffffff`) even when blur enables `transparent: true` +
 *    `vibrancy: 'under-window'`. The opaque layer covers the vibrancy view.
 * 2. `terminalBackgroundOpacity` only rewrites the xterm theme background to
 *    rgba(); it never updates BrowserWindow backgroundColor. With an opaque
 *    window fill, lowering terminal alpha only reveals that same solid color
 *    — never the desktop / blur layer.
 * 3. Blur is read only at window creation (restart required); there is no
 *    live `setVibrancy` / `visualEffectState` path.
 *
 * Re-run:
 *   pnpm exec vitest run --config config/vitest.config.ts \
 *     src/main/window/repro-8797-blur-opacity-noop.test.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  composeActiveTerminalTheme,
  hexToRgba
} from '../../renderer/src/components/terminal-pane/terminal-appearance'

const createMainWindowSource = readFileSync(join(__dirname, 'createMainWindow.ts'), 'utf8')

describe('#8797 macOS window blur + background opacity no-op', () => {
  it('pairs vibrancy with transparent:true AND an always-opaque backgroundColor', () => {
    // Blur path (darwin only)
    expect(createMainWindowSource).toMatch(
      /vibrancy:\s*'under-window'\s+as\s+const,\s*transparent:\s*true/s
    )
    // Opaque solid fill is unconditional — not gated on blur/opacity
    expect(createMainWindowSource).toMatch(
      /backgroundColor:\s*nativeTheme\.shouldUseDarkColors\s*\?\s*'#0a0a0a'\s*:\s*'#ffffff'/
    )
    // No visualEffectState / setBackgroundColor(alpha) / setVibrancy live path
    expect(createMainWindowSource).not.toMatch(/visualEffectState/)
    expect(createMainWindowSource).not.toMatch(/setVibrancy|setBackgroundColor/)
  })

  it('documents that blur is startup-only (settings change needs restart)', () => {
    expect(createMainWindowSource).toMatch(
      /Blur only applies at window creation[\s\S]*changing the setting requires a restart/
    )
    expect(createMainWindowSource).toMatch(
      /const blur = settings\?\.windowBackgroundBlur \?\? false/
    )
  })

  it('applies terminalBackgroundOpacity only to xterm theme rgba, not the window chrome', () => {
    const theme = composeActiveTerminalTheme(
      { background: '#0a0a0a', foreground: '#ffffff' },
      { terminalBackgroundOpacity: 0.3 }
    )
    expect(theme.background).toBe(hexToRgba('#0a0a0a', 0.3))
    expect(theme.background).toBe('rgba(10, 10, 10, 0.3)')
    // Window chrome stays fully opaque hex — same digits as the theme base —
    // so a transparent terminal only reveals #0a0a0a / #ffffff, not blur.
    expect(createMainWindowSource).toContain("'#0a0a0a'")
    expect(createMainWindowSource).toContain("'#ffffff'")
  })

  it('proves opacity=0 still cannot show the desktop while window background is opaque', () => {
    const fullyTransparentTerminal = composeActiveTerminalTheme(
      { background: '#0a0a0a' },
      { terminalBackgroundOpacity: 0 }
    )
    expect(fullyTransparentTerminal.background).toBe('rgba(10, 10, 10, 0)')
    // The window constructor still injects an opaque backgroundColor; with
    // no alpha channel on that fill, a fully transparent xterm still sits
    // on solid black/white — desktop never shows through.
    expect(createMainWindowSource).toMatch(/backgroundColor:\s*nativeTheme/)
  })
})
