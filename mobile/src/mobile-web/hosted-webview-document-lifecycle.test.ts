import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ANDROID_VIEW = source(
  '../../packages/expo-mobile-web-shell/android/src/main/java/expo/modules/mobilewebshell/MobileWebShellView.kt'
)
const ANDROID_MODULE = source(
  '../../packages/expo-mobile-web-shell/android/src/main/java/expo/modules/mobilewebshell/ExpoMobileWebShellModule.kt'
)
const IOS_VIEW = source('../../packages/expo-mobile-web-shell/ios/MobileWebShellView.swift')

describe('hosted WebView document lifecycle', () => {
  // The shell owns the document lifecycle, but a page can replace its own document — the route
  // error boundary reloads in place — and the load start is the only signal that reaches the shell.
  it('reports a document load the page itself starts, on both platforms', () => {
    expect(block(ANDROID_VIEW, 'override fun onPageStarted')).toContain(
      'onLoadState(mapOf("state" to "loading"))'
    )
    expect(
      block(IOS_VIEW, 'func webView(_ webView: WKWebView, didStartProvisionalNavigation')
    ).toContain('onLoadState(["state": "loading"])')
  })

  // Deactivation parks the WebView for a reactivation in place, so only an unmount may destroy it.
  it('destroys the Android WebView on unmount and never on deactivation', () => {
    expect(block(ANDROID_MODULE, 'OnViewDestroys')).toContain('view.destroy()')
    expect(block(ANDROID_VIEW, 'fun destroy()')).toContain('webView.destroy()')
    expect(block(ANDROID_VIEW, 'fun deactivateSessionView()')).not.toContain('webView.destroy()')
    expect(block(ANDROID_VIEW, 'override fun onDetachedFromWindow()')).not.toContain(
      'webView.destroy()'
    )
  })
})

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')
}

/** The declaration through the brace that closes it, so a match cannot leak into the next member. */
function block(text: string, header: string): string {
  const start = text.indexOf(header)
  expect(start, `missing ${header}`).toBeGreaterThanOrEqual(0)
  const indent = text.slice(0, start).split('\n').at(-1) ?? ''
  const end = text.indexOf(`\n${indent}}`, start)
  return text.slice(start, end === -1 ? undefined : end)
}
