package expo.modules.orcamobilewebshell

import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.ScriptHandler
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat

/**
 * What the interceptor is currently allowed to answer. One immutable value, because the map and the
 * host it is keyed against are written on the main thread and read on Chromium's: two fields would
 * let a request see a new generation against the old host, and a plain field would let it see a
 * stale null and refuse a frame we had just served.
 */
internal class MobileWebShellServed(
  val generation: MobileWebShellGeneration,
  val originHost: String
)

internal class MobileWebShellBridgeChannel(
  @Volatile var owner: OrcaMobileWebShellView?
) : WebViewCompat.WebMessageListener {
  override fun onPostMessage(
    view: WebView,
    message: WebMessageCompat,
    sourceOrigin: android.net.Uri,
    isMainFrame: Boolean,
    replyProxy: JavaScriptReplyProxy
  ) {
    owner?.receiveBridgeMessage(message, isMainFrame, replyProxy)
  }
}

internal class RetainedMobileWebShellSlot(
  val applied: MobileWebShellAppliedProps,
  val webView: WebView,
  val served: MobileWebShellServed,
  val blocker: ScriptHandler,
  val bridgeChannel: MobileWebShellBridgeChannel,
  val replyProxy: JavaScriptReplyProxy?,
  val bridgeInstalled: Boolean
)

/**
 * Single-slot LRU retention pool for a healthy, committed host WebView.
 *
 * Retaining at most one host WebView lets Back-to-hosts followed by re-entering the same host
 * reattach the live DOM and JS heap in 0ms while bounding idle native memory to a single instance.
 */
internal class MobileWebShellSlotPool<T>(
  private val onEvict: (T) -> Unit
) {
  private var retained: Pair<MobileWebShellAppliedProps, T>? = null

  @Synchronized
  fun takeMatchingOrEvict(props: MobileWebShellAppliedProps): T? {
    val current = retained ?: return null
    retained = null
    if (current.first.matches(props)) {
      return current.second
    }
    onEvict(current.second)
    return null
  }

  @Synchronized
  fun retain(props: MobileWebShellAppliedProps, value: T) {
    val previous = retained
    retained = props to value
    if (previous != null && previous.second !== value) {
      onEvict(previous.second)
    }
  }

  @Synchronized
  fun clear() {
    val previous = retained
    retained = null
    if (previous != null) {
      onEvict(previous.second)
    }
  }

  @Synchronized
  fun hasRetained(): Boolean = retained != null
}
