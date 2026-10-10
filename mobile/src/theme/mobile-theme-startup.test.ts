import { afterEach, describe, expect, it, vi } from 'vitest'

describe('palette chosen at startup', () => {
  afterEach(() => {
    delete (globalThis as { __orcaTrueBlack?: unknown }).__orcaTrueBlack
    vi.resetModules()
  })

  it('uses the default palette unless true black was set first', async () => {
    const theme = await import('./mobile-theme')
    expect(theme.isTrueBlackActive).toBe(false)
    expect(theme.colors.bgBase).toBe('#111111')
  })

  it('uses the true black palette when set before the theme loads', async () => {
    const state = await import('./true-black-state')
    state.setTrueBlackAtStartup(true)
    const theme = await import('./mobile-theme')
    expect(theme.isTrueBlackActive).toBe(true)
    expect(theme.colors).toBe(theme.trueBlackColors)
  })

  it('uses the true black palette in the terminal WebView when the page says so', async () => {
    ;(globalThis as { __orcaTrueBlack?: unknown }).__orcaTrueBlack = true
    const theme = await import('./mobile-theme')
    expect(theme.colors.terminalBg).toBe('#000000')
  })

  it('passes the palette choice to the terminal WebView as a start value', async () => {
    const start = { textScale: 1, shown: true }
    const off = await import('../terminal/terminal-webview-html')
    expect(off.xtermWebViewSource(start).html).toContain('window.__orcaTrueBlack = false;')

    vi.resetModules()
    const state = await import('./true-black-state')
    state.setTrueBlackAtStartup(true)
    const on = await import('../terminal/terminal-webview-html')
    expect(on.xtermWebViewSource(start).html).toContain('window.__orcaTrueBlack = true;')
  })
})
