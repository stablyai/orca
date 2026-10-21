package expo.modules.orcamobilewebshell

import java.security.MessageDigest

internal const val MOBILE_WEB_SHELL_SCHEME = "https"
internal const val MOBILE_WEB_SHELL_MAX_URL_LENGTH = 8 * 1024
private const val MOBILE_WEB_SHELL_ORIGIN_SUFFIX = ".orca-mobile-web.invalid"
private const val MOBILE_WEB_SHELL_LABEL_LENGTH = 32
private const val MOBILE_WEB_SHELL_MAX_SESSION_ID_LENGTH = 128

internal fun isMobileWebShellSessionId(sessionId: String): Boolean =
  sessionId.isNotEmpty() &&
    sessionId.length <= MOBILE_WEB_SHELL_MAX_SESSION_ID_LENGTH &&
    sessionId.all { it in 'a'..'z' || it in 'A'..'Z' || it in '0'..'9' || it == '-' || it == '_' }

/**
 * The host label is a slice of the session id's digest, never a slice of the session id.
 *
 * Session ids are base64url, and `https` is a special scheme, so Chromium ASCII-lowercases every
 * host it loads and reports back while `java.net.URI.getHost()` answers null for a label holding
 * `_`. The host the interceptor compared against then never equalled the one it was handed, and
 * every asset fell to the refusal branch as a 403. Lowercase hex is canonical under both parsers,
 * 32 characters because a DNS label caps at 63 octets, and `.invalid` is reserved by RFC 2606 so it
 * can never resolve.
 */
internal fun mobileWebShellOriginHost(sessionId: String): String? {
  if (!isMobileWebShellSessionId(sessionId)) return null
  val digest = MessageDigest.getInstance("SHA-256").digest(sessionId.toByteArray(Charsets.UTF_8))
  val label = digest.joinToString("") { byte -> "%02x".format(byte) }
    .take(MOBILE_WEB_SHELL_LABEL_LENGTH)
  return "$label$MOBILE_WEB_SHELL_ORIGIN_SUFFIX"
}

internal fun mobileWebShellOrigin(sessionId: String): String? =
  mobileWebShellOriginHost(sessionId)?.let { host -> "$MOBILE_WEB_SHELL_SCHEME://$host" }

/** A request reduced to the components the predicate reads, so it needs no `android.net.Uri`. */
internal data class MobileWebShellRequestParts(
  val method: String,
  val hasRangeHeader: Boolean,
  val scheme: String?,
  val host: String?,
  val port: Int,
  val userInfo: String?,
  val query: String?,
  val fragment: String?,
  val encodedPath: String?,
  val urlLength: Int
)

/**
 * The map key for a request we are willing to answer, or null to refuse. Every clause is an allow,
 * so a component nobody anticipated falls to refusal rather than through it.
 */
internal fun resolveMobileWebShellRequestPath(
  parts: MobileWebShellRequestParts,
  originHost: String
): String? {
  val path = parts.encodedPath ?: return null
  if (parts.method != "GET" || parts.hasRangeHeader) return null
  if (parts.scheme != MOBILE_WEB_SHELL_SCHEME) return null
  // Hosts are case-insensitive, so a parser that canonicalised one must still bind to this session.
  if (parts.host == null || !parts.host.equals(originHost, ignoreCase = true)) return null
  if (parts.port != -1 || parts.userInfo != null) return null
  if (parts.query != null || parts.fragment != null) return null
  if (parts.urlLength > MOBILE_WEB_SHELL_MAX_URL_LENGTH || path.contains('%')) return null
  if (path.isEmpty() || path == "/") return "/"
  if (!path.startsWith("/")) return null
  return path
}
