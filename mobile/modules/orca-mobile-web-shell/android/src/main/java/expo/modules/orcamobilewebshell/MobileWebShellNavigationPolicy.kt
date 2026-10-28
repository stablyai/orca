package expo.modules.orcamobilewebshell

/** Allow only the served main document; no applied origin means every navigation is dropped. */
internal fun mobileWebShellDropsNavigation(
  parts: MobileWebShellRequestParts,
  originHost: String?,
  isForMainFrame: Boolean
): Boolean {
  if (!isForMainFrame || originHost == null) return true
  return resolveMobileWebShellRequestPath(parts, originHost) != "/"
}


/** Keep allow/refuse/opener routing in one decision shared across platforms. */
internal sealed interface MobileWebShellNavigationVerdict {
  /** The served document loading itself, which is the only navigation this WebView performs. */
  data object Allow : MobileWebShellNavigationVerdict

  /** Refused, and the host is told nothing. Every navigation was this before the preview existed. */
  data object Cancel : MobileWebShellNavigationVerdict

  /** Refused, and the URL is handed to the host's opener, which decides what may open. */
  data class CancelAndOffer(val url: String) : MobileWebShellNavigationVerdict
}

/** Cap native-to-JS URL traffic; TypeScript’s readBridgeExternalLinkUrl owns scheme filtering and its smaller 2048-character limit. */
internal const val MOBILE_WEB_SHELL_MAX_DROPPED_NAVIGATION_URL_CHARS = 4096

/** The URL a dropped navigation may be offered under, or null when nothing crosses. */
internal fun mobileWebShellOfferableUrl(url: String?): String? {
  if (url == null || url.isEmpty()) return null
  return if (url.length > MOBILE_WEB_SHELL_MAX_DROPPED_NAVIGATION_URL_CHARS) null else url
}

/** Refuse subframes and document-URL navigations; only gestured foreign URLs reach the host opener.
 * Android loadUrl bypasses this callback, so isShellLoad is always false; redirects do reach it.
 * Do not trust hasGesture to permit loads: human requests may lack it and subframes can target top without it.
 * isFromSubframe/isDownload mirror iOS; Chromium omits source frames and routes downloads to our no-op listener.
 * A provider that routes loadUrl here fails closed at loading; the shell serves no redirects. */
internal fun mobileWebShellNavigationVerdict(
  url: String?,
  isForMainFrame: Boolean,
  isFromSubframe: Boolean,
  isDocumentUrl: Boolean,
  isShellLoad: Boolean,
  hasGesture: Boolean,
  isDownload: Boolean
): MobileWebShellNavigationVerdict {
  if (!isForMainFrame) return MobileWebShellNavigationVerdict.Cancel
  if (isDocumentUrl) {
    return if (isShellLoad && !isFromSubframe && !isDownload) {
      MobileWebShellNavigationVerdict.Allow
    } else {
      MobileWebShellNavigationVerdict.Cancel
    }
  }
  if (!hasGesture) return MobileWebShellNavigationVerdict.Cancel
  val offered = mobileWebShellOfferableUrl(url) ?: return MobileWebShellNavigationVerdict.Cancel
  return MobileWebShellNavigationVerdict.CancelAndOffer(offered)
}
