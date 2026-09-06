import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MOBILE_RICH_MARKDOWN_EDITOR_SCRIPT_CSP_HASH } from '../../../src/shared/mobile-web/markdown-editor-csp'

const iosShellViewSource = readFileSync(
  new URL('../../packages/expo-mobile-web-shell/ios/MobileWebShellView.swift', import.meta.url),
  'utf8'
)
const androidShellViewSource = readFileSync(
  new URL(
    '../../packages/expo-mobile-web-shell/android/src/main/java/expo/modules/mobilewebshell/MobileWebShellView.kt',
    import.meta.url
  ),
  'utf8'
)
const androidPackageStoreSource = readFileSync(
  new URL(
    '../../packages/expo-mobile-web-shell/android/src/main/java/expo/modules/mobilewebshell/MobileWebPackageStore.kt',
    import.meta.url
  ),
  'utf8'
)

describe('mobile web shell root route', () => {
  it('loads the iOS package document at the router root without widening navigation', () => {
    expect(iosShellViewSource).toContain(
      'let path = requestPath.isEmpty ? "index.html" : requestPath'
    )
    expect(iosShellViewSource).toContain('URL(string: "\\(mobileWebScheme)://\\(sessionId)/")')
    expect(iosShellViewSource).toContain('url.path == "/"')
    expect(iosShellViewSource).not.toContain('url.path == "/index.html"')
    expect(iosShellViewSource).toContain("\"style-src 'self' 'unsafe-inline'\"")
    expect(iosShellViewSource).toContain(
      `"script-src 'self' ${MOBILE_RICH_MARKDOWN_EDITOR_SCRIPT_CSP_HASH}"`
    )
    expect(iosShellViewSource).not.toContain("\"script-src 'self' 'unsafe-inline'\"")
  })

  it('loads the Android package document at the router root without widening navigation', () => {
    expect(androidShellViewSource).toContain(
      'webView.loadUrl("${mobileWebOriginForSession(sessionId)}/#$sessionId")'
    )
    expect(androidShellViewSource).toContain(
      'val path = if (requestPath.isEmpty()) "index.html" else requestPath'
    )
    expect(androidShellViewSource).toContain(
      '(url.fragment == null || (request.isForMainFrame && url.fragment == sessionId))'
    )
    expect(androidShellViewSource).toContain("!url.encodedPath.orEmpty().contains('%')")
    expect(androidShellViewSource).toContain('url.path == "/"')
    expect(androidShellViewSource).toContain('url.encodedPath == "/"')
    expect(androidShellViewSource).toContain('url.query == null')
    expect(androidShellViewSource).toContain('val sessionId = activeSessionId ?: return false')
    expect(androidShellViewSource).toContain('url.fragment == sessionId &&')
    expect(androidPackageStoreSource).toContain(
      '"url" to "${mobileWebOriginForSession(sessionId)}/#$sessionId"'
    )
  })
})
