package expo.modules.mobilewebshell

import java.net.URI

private const val MOBILE_WEB_DOCUMENT_URL_LIMIT = 8 * 1024

internal fun isAllowedMobileWebBridgeDocumentUrl(value: String, sessionId: String): Boolean =
  runCatching {
    val url = URI(value)
    value.length <= MOBILE_WEB_DOCUMENT_URL_LIMIT &&
      url.scheme == MOBILE_WEB_ORIGIN_SCHEME &&
      isMobileWebOriginHostForSession(url.host, sessionId) &&
      url.port == -1 &&
      url.userInfo == null &&
      url.fragment == sessionId
  }.getOrDefault(false)
