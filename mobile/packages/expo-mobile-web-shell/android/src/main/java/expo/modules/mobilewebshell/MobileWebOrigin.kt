package expo.modules.mobilewebshell

import android.net.Uri
import java.security.MessageDigest

private const val MOBILE_WEB_ORIGIN_SUFFIX = ".orca-mobile-web.invalid"
private const val MOBILE_WEB_ORIGIN_LABEL_LENGTH = 32

/**
 * Derives a per-session origin so WebView cookies/storage cannot cross hosts.
 *
 * The label is hashed rather than sliced off the session id: the bridge contract pins session ids
 * to base64url, which a URL host cannot carry. `https` is a special scheme, so Chromium
 * ASCII-lowercases every host it loads and reports back, and `java.net.URI.getHost()` is null for a
 * label holding `_`. Lowercase hex is canonical under both.
 */
internal fun mobileWebOriginForSession(sessionId: String): String {
  require(
    sessionId.isNotEmpty() &&
      sessionId.length <= 128 &&
      sessionId.all { it.isLetterOrDigit() || it == '-' || it == '_' }
  ) {
    "mobile_web_session_id_invalid"
  }
  return "$MOBILE_WEB_ORIGIN_SCHEME://${mobileWebOriginLabelForSession(sessionId)}$MOBILE_WEB_ORIGIN_SUFFIX"
}

private fun mobileWebOriginLabelForSession(sessionId: String): String =
  MessageDigest.getInstance("SHA-256")
    .digest(sessionId.toByteArray(Charsets.UTF_8))
    .joinToString("") { "%02x".format(it) }
    .take(MOBILE_WEB_ORIGIN_LABEL_LENGTH)

internal fun mobileWebOriginUriForSession(sessionId: String): Uri = Uri.parse(mobileWebOriginForSession(sessionId))

/** Android-free host projection so JVM unit tests can check origins without android.net.Uri. */
internal fun mobileWebOriginHostForSession(sessionId: String): String =
  mobileWebOriginForSession(sessionId).substringAfter("://")

/** Hosts are case-insensitive, so a non-canonical parser must still bind to the active session. */
internal fun isMobileWebOriginHostForSession(host: String?, sessionId: String): Boolean =
  host != null && host.equals(mobileWebOriginHostForSession(sessionId), ignoreCase = true)

internal fun isMobileWebOriginForSession(url: Uri, sessionId: String): Boolean =
  url.scheme == MOBILE_WEB_ORIGIN_SCHEME &&
    isMobileWebOriginHostForSession(url.host, sessionId) &&
    url.port == -1 &&
    url.userInfo == null
