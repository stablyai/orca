/**
 * Issue #8482 — Window Blur causes sustained high GPU power/heat on macOS.
 *
 * Code-level contract (not live powermetrics):
 * 1. Blur maps to Electron `vibrancy: 'under-window'` + `transparent: true`.
 * 2. macOS always disables background throttling on the main window.
 * 3. Blur is window-creation-only (restart required), so a misconfigured
 *    vibrancy path stays active for the whole session.
 *
 * Issue reporter measured ~5.3 W GPU with blur visible vs ~0.8 W with blur
 * off and ~0.6 W when the same processes stay up but the window is hidden —
 * isolating cost to visible composition, not PTYs alone.
 *
 * Re-run:
 *   pnpm exec vitest run --config config/vitest.config.ts \
 *     src/main/window/repro-8482-window-blur-gpu-cost.test.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const createMainWindowSource = readFileSync(join(__dirname, 'createMainWindow.ts'), 'utf8')

describe('#8482 macOS Window Blur GPU composition cost (config contract)', () => {
  it('maps Window Blur to vibrancy + transparent on darwin', () => {
    expect(createMainWindowSource).toMatch(
      /const blur = settings\?\.windowBackgroundBlur \?\? false/
    )
    expect(createMainWindowSource).toMatch(
      /process\.platform === 'darwin'\s*\?\s*\{\s*vibrancy:\s*'under-window'\s+as\s+const,\s*transparent:\s*true/s
    )
    // Spread into BrowserWindow so blur is a window-level compositor path
    expect(createMainWindowSource).toMatch(/\.\.\.platformBlurOptions/)
  })

  it('disables background throttling on every macOS main window', () => {
    // Why: throttling off keeps compositor/animation work eligible while
    // vibrancy is visible — pairs with continuous GPU draw in the report.
    expect(createMainWindowSource).toMatch(
      /if \(process\.platform === 'darwin'\)[\s\S]*setBackgroundThrottling\(false\)/
    )
  })

  it('applies blur only at window construction (no live setVibrancy teardown)', () => {
    expect(createMainWindowSource).toMatch(
      /Blur only applies at window creation[\s\S]*changing the setting requires a restart/
    )
    expect(createMainWindowSource).not.toMatch(/setVibrancy/)
    // No path to drop vibrancy without recreating the window
    expect(createMainWindowSource).not.toMatch(/visualEffectState/)
  })
})
