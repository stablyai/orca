import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const injectedSource = readFileSync(
  new URL('./terminal-dir-listing-size-dim-injected.ts', import.meta.url),
  'utf8'
)
const webViewSource = readFileSync(new URL('./TerminalWebView.tsx', import.meta.url), 'utf8')
const htmlSource = readFileSync(new URL('./terminal-webview-html.ts', import.meta.url), 'utf8')

describe('dir-listing size dim wiring', () => {
  it('disposes the association marker when clearing decorations', () => {
    expect(injectedSource).toMatch(
      /try\s*\{\s*sizeDimDecorations\[i\]\.marker\.dispose\(\);\s*\}\s*catch/
    )
    expect(injectedSource).toMatch(/try\s*\{\s*sizeDimDecorations\[i\]\.dispose\(\);\s*\}\s*catch/)
  })

  it('tints size-dim overlays from terminalTheme.background', () => {
    expect(injectedSource).toMatch(/terminalTheme\.background/)
    expect(injectedSource).not.toMatch(/document\.body\.style\.background/)
  })

  it('refreshes size-dim decorations after set-theme', () => {
    const setThemeIdx = htmlSource.indexOf("msg.type === 'set-theme'")
    expect(setThemeIdx).toBeGreaterThanOrEqual(0)
    const nextBranch = htmlSource.indexOf("} else if (msg.type ===", setThemeIdx + 1)
    const setThemeBlock = htmlSource.slice(setThemeIdx, nextBranch > setThemeIdx ? nextBranch : undefined)
    expect(setThemeBlock).toContain('scheduleSizeDimRefresh')
  })

  it('subscribes before load so a live toggle is not overridden by a stale initial read', () => {
    const effectStart = webViewSource.indexOf(
      'settings toggle must dim already-mounted terminals without a reload'
    )
    expect(effectStart).toBeGreaterThanOrEqual(0)
    const effectEnd = webViewSource.indexOf('}, [postMessage])', effectStart)
    expect(effectEnd).toBeGreaterThan(effectStart)
    const effect = webViewSource.slice(effectStart, effectEnd)
    const subscribeIdx = effect.indexOf('subscribeTerminalDimDirListingSizes')
    const loadIdx = effect.indexOf('loadTerminalDimDirListingSizes')
    expect(subscribeIdx).toBeGreaterThanOrEqual(0)
    expect(loadIdx).toBeGreaterThan(subscribeIdx)
    expect(effect).toContain('receivedSubscriptionUpdate')
    expect(effect).toMatch(/!cancelled\s*&&\s*!receivedSubscriptionUpdate/)
  })
})
