import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MOBILE_WEB_BRIDGE_MAX_MESSAGE_BYTES } from '../../../src/shared/mobile-web/bridge-contract'
import { mobileWebDocumentCspDirectives } from '../../../src/shared/mobile-web/document-csp'
import { MOBILE_RICH_MARKDOWN_EDITOR_SCRIPT_CSP_HASH } from '../../../src/shared/mobile-web/markdown-editor-csp'
import { mobileWebMermaidFrameCspDirectives } from '../../../src/shared/mobile-web/mermaid-frame-document'

const iosSource = readFileSync(
  new URL('../../packages/expo-mobile-web-shell/ios/MobileWebShellView.swift', import.meta.url),
  'utf8'
)
const iosModuleSource = readFileSync(
  new URL(
    '../../packages/expo-mobile-web-shell/ios/ExpoMobileWebShellModule.swift',
    import.meta.url
  ),
  'utf8'
)
const androidSource = readFileSync(
  new URL(
    '../../packages/expo-mobile-web-shell/android/src/main/java/expo/modules/mobilewebshell/MobileWebShellView.kt',
    import.meta.url
  ),
  'utf8'
)
const androidBlockerSource = readFileSync(
  new URL(
    '../../packages/expo-mobile-web-shell/android/src/main/java/expo/modules/mobilewebshell/MobileWebNetworkApiBlocker.kt',
    import.meta.url
  ),
  'utf8'
)
const androidModuleSource = readFileSync(
  new URL(
    '../../packages/expo-mobile-web-shell/android/src/main/java/expo/modules/mobilewebshell/ExpoMobileWebShellModule.kt',
    import.meta.url
  ),
  'utf8'
)
const androidBridgeUrlSource = readFileSync(
  new URL(
    '../../packages/expo-mobile-web-shell/android/src/main/java/expo/modules/mobilewebshell/MobileWebBridgeDocumentUrl.kt',
    import.meta.url
  ),
  'utf8'
)
const viewRefSource = readFileSync(
  new URL('../../packages/expo-mobile-web-shell/src/ExpoMobileWebShellView.ts', import.meta.url),
  'utf8'
)

describe('mobile web native bridge transport', () => {
  it('keeps both native message limits aligned with the shared envelope limit', () => {
    expect(MOBILE_WEB_BRIDGE_MAX_MESSAGE_BYTES).toBe(640 * 1024)
    expect(iosSource).toContain('mobileWebMessageByteLimit = 640 * 1024')
    expect(androidSource).toContain('MOBILE_WEB_MESSAGE_BYTE_LIMIT = 640 * 1024')
  })

  it('retains origin, main-frame, and navigation enforcement on both platforms', () => {
    expect(iosSource).toContain('message.frameInfo.isMainFrame')
    expect(iosSource).toContain('isAllowedMobileWebOriginForSession(source, sessionId: sessionId)')
    expect(iosSource).toContain(
      'isAllowedMobileWebBridgeDocumentUrl(message.frameInfo.request.url, sessionId: sessionId)'
    )
    expect(iosSource).toContain('navigationAction.targetFrame?.isMainFrame == true')
    expect(iosSource).toContain('decisionHandler(.cancel)')
    expect(androidSource).toContain('!isMainFrame')
    expect(androidSource).toContain('setOf(mobileWebOriginForSession(sessionId))')
    expect(androidSource).toContain('!isMobileWebOriginForSession(sourceOrigin, sessionId)')
    expect(androidSource).toContain(
      '!isAllowedMobileWebBridgeDocumentUrl(documentUrl.toString(), sessionId)'
    )
    expect(androidBridgeUrlSource).toContain('url.scheme == MOBILE_WEB_ORIGIN_SCHEME')
    expect(androidBridgeUrlSource).toContain('isMobileWebOriginHostForSession(url.host, sessionId)')
    expect(androidBridgeUrlSource).toContain('url.fragment == sessionId')
    expect(androidBridgeUrlSource).toContain('url.userInfo == null')
    expect(androidSource).toContain('request.isForMainFrame && isAllowedDocumentUrl(url)')
    expect(androidSource).toContain('return !allowed')
  })

  it('binds iOS custom-scheme requests to the active session origin', () => {
    expect(iosSource).toContain('let sessionId = activeSessionId')
    expect(iosSource).toContain('isAllowedMobileWebOriginForSession(url, sessionId: sessionId)')
    expect(iosSource).toContain('url.port == nil')
    expect(iosSource).toContain('url.user == nil')
    expect(iosSource).toContain('url.fragment == nil')
    expect(iosSource).toContain('schemeHandler.activeSessionId = nil')
  })

  it('disables network loads, downloads, browser gestures, script windows, and popups', () => {
    expect(iosSource).toContain('"url-filter": "^https?://.*"')
    expect(iosSource).toContain('"url-filter": "^wss?://.*"')
    expect(iosSource).toContain('"action": { "type": "block" }')
    expect(iosSource).toContain('installMobileWebNetworkBlocker(')
    expect(iosSource).toContain('networkBlockReady')
    expect(iosSource).toContain('networkBlockFailed')
    expect(iosSource).not.toContain('limitsNavigationsToAppBoundDomains')
    expect(iosSource).toContain('Object.defineProperties(globalThis')
    expect(iosSource).toContain('var restrictedNavigator=new Proxy(nativeNavigator')
    expect(iosSource).toContain("if(property==='serviceWorker') return undefined")
    expect(iosSource).toContain("Object.defineProperty(globalThis,'navigator'")
    expect(iosSource).toContain('var serviceWorkerPrototype=Object.getPrototypeOf')
    expect(iosSource).toContain("Object.defineProperty(serviceWorkerPrototype,'register'")
    expect(iosSource).toContain("Object.defineProperty(navigator,'serviceWorker'")
    expect(iosSource).toContain("Object.defineProperty(Navigator.prototype,'serviceWorker'")
    expect(iosSource).toContain("anchor.hasAttribute('download')")
    expect(iosSource).toContain('event.preventDefault()')
    expect(iosSource).toContain('Network access is disabled')
    expect(iosSource).not.toContain('Image:{')
    expect(iosSource).toContain('globalThis.__orcaRunSecurityProbe=function()')
    expect(iosSource).toContain('source: mobileWebNetworkApiBlocker')
    expect(iosSource).toContain('forMainFrameOnly: false')
    expect(iosSource).toContain('navigationAction.shouldPerformDownload')
    expect(iosSource).toContain('decidePolicyFor navigationResponse: WKNavigationResponse')
    expect(iosSource).toContain('navigationResponse.canShowMIMEType')
    expect(iosSource).toContain(
      'configuration.preferences.javaScriptCanOpenWindowsAutomatically = false'
    )
    expect(iosSource).toContain('webView.allowsBackForwardNavigationGestures = false')
    expect(iosSource).toContain('createWebViewWith configuration: WKWebViewConfiguration')
    expect(iosSource).toContain('return nil')
    expect(androidSource).toContain('javaScriptCanOpenWindowsAutomatically = false')
    expect(androidSource).toContain('setSupportMultipleWindows(false)')
    expect(androidSource).toContain('blockNetworkLoads = true')
    expect(androidSource).toContain('webView.setDownloadListener')
    expect(androidSource).toContain('override fun onCreateWindow(')
    expect(androidSource).toContain('): Boolean = false')
  })

  it('denies the same page network APIs at document start on both platforms', () => {
    const blocker = nativeBlockerScript(iosSource, 'mobileWebNetworkApiBlocker = """')
    expect(blocker).toContain('Network access is disabled')
    expect(blocker).toContain('WebSocket:{')
    expect(nativeBlockerScript(androidBlockerSource, 'MOBILE_WEB_NETWORK_API_BLOCKER = """')).toBe(
      blocker
    )
    expect(androidBlockerSource).toContain('WebViewFeature.DOCUMENT_START_SCRIPT')
    expect(androidBlockerSource).toContain('WebViewCompat.addDocumentStartJavaScript(')
    expect(androidBlockerSource).toContain('setOf(allowedOrigin)')
    expect(androidBlockerSource).toContain('mobile_web_network_api_blocker_unavailable')
    // The session load and the in-place onRenderProcessGone reload both need the blocker.
    expect(androidSource.match(/installMobileWebNetworkApiBlocker\(/g)).toHaveLength(2)
    expect(androidSource).toContain('mobileWebOriginForSession(sessionId)')
    expect(androidSource).toContain('networkBlockerScriptHandler?.remove()')
  })

  it('exposes the iOS document inspector only in debug builds', () => {
    expect(iosSource).toContain(
      '#if DEBUG\n    if #available(iOS 16.4, *) {\n      webView.isInspectable = true\n    }\n    #endif'
    )
  })

  it('hides cleared native WebViews before a shell route can reveal them', () => {
    expect(viewRefSource).toContain('activateSessionView(sessionId: string): Promise<void>')
    expect(viewRefSource).toContain('deactivateSessionView(): Promise<void>')
    expect(iosModuleSource).toContain('AsyncFunction("activateSessionView")')
    expect(iosModuleSource).toContain('AsyncFunction("deactivateSessionView")')
    expect(iosModuleSource).toContain('view.activateSessionView(sessionId)')
    expect(iosModuleSource).toContain('view.deactivateSessionView()')
    expect(androidModuleSource).toContain('AsyncFunction("activateSessionView")')
    expect(androidModuleSource).toContain('AsyncFunction("deactivateSessionView")')
    expect(androidModuleSource).toContain('view.activateSessionView(sessionId)')
    expect(androidModuleSource).toContain('view.deactivateSessionView()')
    expect(androidModuleSource).toContain('AsyncFunction("activateViewSession")')
    expect(androidModuleSource).toContain('AsyncFunction("deactivateViewSession")')
    expect(androidModuleSource).toContain('AsyncFunction("postViewMessage")')
    expect(androidModuleSource).toContain('.runOnQueue(Queues.MAIN)')
    expect(androidModuleSource).toContain(
      'sessionViews[sessionId]?.postMessageIfActive(sessionId, message)'
    )
    expect(androidSource).toContain('fun postMessageIfActive(sessionId: String, message: String)')
    expect(androidSource).toContain('if (activeSessionId == sessionId) postMessage(message)')
    expect(viewRefSource).toContain('ExpoMobileWebShellModule.activateViewSession(sessionId)')
    expect(viewRefSource).toContain('ExpoMobileWebShellModule.deactivateViewSession(sessionId)')
    expect(viewRefSource).toContain('ExpoMobileWebShellModule.postViewMessage(sessionId, message)')
    expect(iosSource).toContain('func activateSessionView(_ sessionId: String)')
    expect(iosSource).toContain('func deactivateSessionView()')
    expect(androidSource).toContain('fun activateSessionView(sessionId: String)')
    expect(androidSource).toContain('fun deactivateSessionView()')
    expect(iosSource).toContain('webView.loadHTMLString("", baseURL: nil)\n    detachWebView()')
    expect(iosSource).toContain('webView.removeFromSuperview()')
    expect(iosSource).toContain('attachWebView()\n    isHidden = false')
    expect(iosSource).toContain('isHidden = false')
    expect(iosSource).toContain('webView.isHidden = false')
    expect(androidSource).toContain('webView.loadUrl("about:blank")\n    removeView(webView)')
    expect(androidSource).toContain('attachWebView()\n    visibility = View.VISIBLE')
    expect(androidSource).toContain('visibility = View.VISIBLE')
    expect(androidSource).toContain('webView.visibility = View.VISIBLE')
    expect(androidSource).toContain('override fun onAttachedToWindow()')
    expect(androidSource).toContain('addBridgeMessageListener(sessionId)')
    expect(androidSource).toContain(
      '!documentLoaded || currentUrl == null || !isAllowedDocumentUrl(currentUrl)'
    )
    expect(androidSource).toContain('bridgeMessageListenerAttached = false')
    expect(androidSource).toContain('if (bridgeMessageListenerAttached) return')
  })

  it('allows only reviewed data and private-origin embedded documents', () => {
    const expected = mobileWebDocumentCspDirectives(MOBILE_RICH_MARKDOWN_EDITOR_SCRIPT_CSP_HASH)
    expect(nativeCspDirectives(iosSource, 'mobileWebCsp')).toEqual(expected)
    expect(nativeCspDirectives(androidSource, 'MOBILE_WEB_CSP')).toEqual(expected)
    expect(nativeCspDirectives(iosSource, 'mobileWebMermaidFrameCsp')).toEqual(
      mobileWebMermaidFrameCspDirectives()
    )
    expect(nativeCspDirectives(androidSource, 'MOBILE_WEB_MERMAID_FRAME_CSP')).toEqual(
      mobileWebMermaidFrameCspDirectives()
    )
    for (const source of [iosSource, androidSource]) {
      expect(source).toContain('"frame-src \'self\' data:"')
      expect(source).toContain('"child-src \'self\' data:"')
      expect(source).toContain('"connect-src \'none\'"')
      expect(source).toContain('"worker-src \'none\'"')
      expect(source).toContain('"base-uri \'none\'"')
      expect(source).toContain('"form-action \'none\'"')
      expect(source).not.toContain("\"script-src 'self' 'unsafe-inline'\"")
    }
    expect(iosSource).toContain(
      `"script-src 'self' ${MOBILE_RICH_MARKDOWN_EDITOR_SCRIPT_CSP_HASH}"`
    )
    expect(iosSource).toContain("\"style-src 'self' 'unsafe-inline'\"")
    expect(androidSource).toContain(
      `"script-src 'self' ${MOBILE_RICH_MARKDOWN_EDITOR_SCRIPT_CSP_HASH}"`
    )
    expect(androidSource).toContain("\"style-src 'self' 'unsafe-inline'\"")
    expect(androidSource).toContain('"font-src \'self\'"')
    expect(androidSource).toContain('"img-src \'self\' data: blob:"')
    expect(iosSource).toContain('navigationAction.targetFrame?.isMainFrame == false')
    expect(iosSource).toContain('navigationAction.request.url?.scheme == "data"')
    expect(iosSource).toContain('isAllowedEmbeddedDocumentUrl(navigationAction.request.url)')
    expect(androidSource).toContain('!request.isForMainFrame && url.scheme == "data"')
    expect(androidSource).toContain('!request.isForMainFrame && isAllowedEmbeddedDocumentUrl(url)')
  })
})

const KOTLIN_ESCAPED_DOLLAR = '$' + "{'$'}"

function nativeBlockerScript(source: string, declaration: string): string {
  const opening = source.indexOf(declaration)
  if (opening === -1) {
    return ''
  }
  const bodyStart = source.indexOf('\n', opening + declaration.length) + 1
  const closing = source.indexOf('"""', bodyStart)
  return source
    .slice(bodyStart, closing)
    .replaceAll(KOTLIN_ESCAPED_DOLLAR, () => '$')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n')
}

function nativeCspDirectives(source: string, declaration: string): string[] {
  const kotlinStart = source.indexOf(`${declaration} = listOf(`)
  const swiftStart = source.indexOf(`${declaration} = [`)
  const opening = kotlinStart !== -1 ? kotlinStart : swiftStart
  const closing = source.indexOf(kotlinStart !== -1 ? ').joinToString' : '].joined', opening)
  if (opening === -1 || closing === -1) {
    return []
  }
  return [...source.slice(opening, closing).matchAll(/^\s*"([^"]+)",?$/gm)].map(
    (match) => match[1]!
  )
}
