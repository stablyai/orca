import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { colors } from '../theme/mobile-theme'

/**
 * What the WebView paints before its document does, read off both shells.
 *
 * Neither can be proven from a JVM or a Swift unit test: it is a property of a live view. What is
 * checkable is that neither shell gives the view a surface of its own, which is what makes the
 * frame behind it — the screen's own, in the app's own colours — the thing on screen.
 *
 * The two defaults differ and both are wrong. Android's WebView paints nothing under a transparent
 * background, which is fine; a WKWebView is opaque by default and paints white, so a dark app
 * opening a page flashed white for the whole of the page's boot.
 */
const SHELL = join(import.meta.dirname, '..', '..', 'modules', 'orca-mobile-web-shell')

function source(relative: string): string {
  return readFileSync(join(SHELL, relative), 'utf8')
}

describe('what a mounted view paints before the page does', () => {
  it('gives the Android view no surface of its own', () => {
    const kotlin = source(
      'android/src/main/java/expo/modules/orcamobilewebshell/MobileWebShellView.kt'
    )
    expect(kotlin).toContain('view.setBackgroundColor(Color.TRANSPARENT)')
  })

  it('gives the iOS view none either, which is not its default', () => {
    const swift = source('ios/MobileWebShellView.swift')
    expect(swift).toContain('webView.isOpaque = false')
    expect(swift).toContain('webView.backgroundColor = .clear')
    expect(swift).toContain('webView.scrollView.backgroundColor = .clear')
  })

  it('leaves the app surface as the one colour behind a page, and it is not black', () => {
    // What shows through both: the screen's own root, which is where the token is read.
    const screen = readFileSync(join(import.meta.dirname, 'MobileWebShellScreen.tsx'), 'utf8')
    expect(screen).toContain('backgroundColor: colors.bgBase')
    expect(colors.bgBase).not.toBe('#000000')
  })
})
