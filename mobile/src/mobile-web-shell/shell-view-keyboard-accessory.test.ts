import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The iOS shell's keyboard, read off the Swift view: a property of a live WKWebView, so what is
 * checkable here is that the view installs the fix, and the simulator proof measures its effect.
 *
 * iPhone 17 simulator, measured: WKWebView's form accessory bar (up, down, done) rides on the
 * keyboard, and the keyboard event's height counts it, so the page's terminal lifted 376 pt against
 * native's 274 and its dock stood 52 pt above the bar.
 */
const SHELL = join(import.meta.dirname, '..', '..', 'modules', 'orca-mobile-web-shell', 'ios')

describe("the iOS WebView's keyboard", () => {
  it('carries no form accessory bar, so the keyboard is the height a native screen reads', () => {
    const view = readFileSync(join(SHELL, 'MobileWebShellView.swift'), 'utf8')
    expect(view).toContain('hideKeyboardAccessoryBar(of: webView)')
    const accessory = readFileSync(join(SHELL, 'MobileWebShellKeyboardAccessory.swift'), 'utf8')
    expect(accessory).toContain('inputAccessoryView')
  })
})
