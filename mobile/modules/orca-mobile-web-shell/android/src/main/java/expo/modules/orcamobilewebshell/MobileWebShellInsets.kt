package expo.modules.orcamobilewebshell

import androidx.core.graphics.Insets
import androidx.core.view.WindowInsetsCompat

/**
 * The shell pads the bars and shortens the WebView for the keyboard, so WebView M144+ forwarding
 * systemBars/displayCutout to env(safe-area-inset-*), and M139+ resizing for ime(), pad twice.
 * Zeroed, never CONSUMED, so later changes still arrive (Android "Understand window insets in WebView").
 */
internal fun insetsForShellPage(insets: WindowInsetsCompat): WindowInsetsCompat =
  WindowInsetsCompat.Builder(insets)
    .setInsets(SHELL_OWNED_INSET_TYPES, Insets.NONE)
    .build()

private val SHELL_OWNED_INSET_TYPES =
  WindowInsetsCompat.Type.systemBars() or
    WindowInsetsCompat.Type.displayCutout() or
    WindowInsetsCompat.Type.ime()
