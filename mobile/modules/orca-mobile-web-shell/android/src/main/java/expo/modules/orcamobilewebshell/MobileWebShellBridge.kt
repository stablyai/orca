package expo.modules.orcamobilewebshell

/** Shared page/native bridge contract; framework-free for off-device checks. */
internal const val MOBILE_WEB_SHELL_BRIDGE_OBJECT = "orcaBridge"

/** Enforce the shared UTF-8 JSON byte ceiling natively, before parsing. */
internal const val MOBILE_WEB_SHELL_BRIDGE_MAX_MESSAGE_BYTES = 640 * 1024

internal fun acceptsMobileWebShellBridgeByteCount(byteCount: Int): Boolean =
  byteCount <= MOBILE_WEB_SHELL_BRIDGE_MAX_MESSAGE_BYTES

/** Chromium checks origins; native also requires the current committed main frame. A replaced same-origin document stays alive until commit. */
internal fun acceptsMobileWebShellBridgeFrame(
  isMainFrame: Boolean,
  isStringMessage: Boolean,
  hasCommittedDocument: Boolean
): Boolean = isMainFrame && isStringMessage && hasCommittedDocument

/** Silently count refusals for tests without revealing the cap to the page. */
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

/** Query capability, not version; disabled bridges must still load on unsupported providers. */
internal fun mobileWebShellBridgeInstall(
  bridgeEnabled: Boolean,
  isListenerSupported: Boolean
): MobileWebShellBridgeInstall = when {
  !bridgeEnabled -> MobileWebShellBridgeInstall.SKIP
  isListenerSupported -> MobileWebShellBridgeInstall.INSTALL
  else -> MobileWebShellBridgeInstall.UNAVAILABLE
}
