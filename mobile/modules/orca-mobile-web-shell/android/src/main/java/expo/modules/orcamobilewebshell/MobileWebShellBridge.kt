package expo.modules.orcamobilewebshell

/**
 * The `WebMessageListener` name, which is also the global Chromium injects into the page. iOS
 * installs a global of the same name, so one page reaches both shells.
 */
internal const val MOBILE_WEB_SHELL_BRIDGE_OBJECT = "orcaBridge"

/**
 * Measured on the raw JSON string in UTF-8, before anything parses it. The TypeScript contract holds
 * the same ceiling; native is the one that cannot be talked out of it.
 */
internal const val MOBILE_WEB_SHELL_BRIDGE_MAX_MESSAGE_BYTES = 640 * 1024

internal fun acceptsMobileWebShellBridgeByteCount(byteCount: Int): Boolean =
  byteCount <= MOBILE_WEB_SHELL_BRIDGE_MAX_MESSAGE_BYTES

/**
 * Chromium enforces the allowed-origin set before the listener runs, so the origin is not re-checked
 * here; what is left is the frame. CSP already says `frame-src 'none'`, but the injected object
 * reaches every same-origin frame, so the shell states the main-frame rule itself rather than
 * inheriting it from a header a future bundle could need relaxed.
 *
 * The document the current props replaced is same-origin whenever only the directory or the bridge
 * prop changed, and it is alive until the next one commits, so it has to be refused by when it
 * spoke rather than by where it spoke from.
 */
internal fun acceptsMobileWebShellBridgeFrame(
  isMainFrame: Boolean,
  isStringMessage: Boolean,
  hasCommittedDocument: Boolean
): Boolean = isMainFrame && isStringMessage && hasCommittedDocument

/**
 * Refusal is silent: the shell exposes no new state and tells the page nothing, because a page that
 * learns which messages were dropped learns the cap. The tally is what a test can hold the cap to.
 */
internal class MobileWebShellBridgeGate {
  var refusedCount = 0
    private set

  fun accepts(byteCount: Int): Boolean {
    if (!acceptsMobileWebShellBridgeByteCount(byteCount)) {
      refusedCount += 1
      return false
    }
    return true
  }
}

/** What a prop update should do about the listener, decided before any WebView call. */
internal enum class MobileWebShellBridgeInstall {
  /** The prop is false, so nothing is registered and Phase B behaviour is byte-identical. */
  SKIP,
  INSTALL,
  /** The WebView provider is older than `WEB_MESSAGE_LISTENER` (Chromium 88). Terminal. */
  UNAVAILABLE
}

/**
 * The floor is asked as a feature query and never as a version string: the query is the capability.
 * An unsupported provider only matters when the bridge was asked for, so the enabled check comes
 * first — with the prop false the shell must load on a WebView the bridge could not run on.
 */
internal fun mobileWebShellBridgeInstall(
  bridgeEnabled: Boolean,
  isListenerSupported: Boolean
): MobileWebShellBridgeInstall = when {
  !bridgeEnabled -> MobileWebShellBridgeInstall.SKIP
  isListenerSupported -> MobileWebShellBridgeInstall.INSTALL
  else -> MobileWebShellBridgeInstall.UNAVAILABLE
}
