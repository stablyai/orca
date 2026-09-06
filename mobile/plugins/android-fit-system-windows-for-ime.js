const { withMainActivity } = require('expo/config-plugins')

// Why: expo-modules-core's EdgeToEdgePackage force-enables edge-to-edge at activity create, so
// the window keeps decorFitsSystemWindows=false and the system never insets it for the IME. In
// multi-window the shell owns the IME (imeControlTarget is a RemoteInsetsControlTarget) and
// reports no ime inset either — measured on a razr fold as a -31.9dp keyboard height — so
// nothing can lift content off the keyboard there. Fitting system windows restores that inset,
// but only in multi-window: full screen reports the IME normally and keeps edge-to-edge, and
// fitting there would double up with the layout's own keyboard lift. Honored only because
// android-optout-edge-to-edge-enforcement.js opts the theme out of the Android 15+ enforcement.
//
// Known gap: freeform and desktop-mode windows are also multi-window but do receive the ime
// inset, so they get the system inset they do not need. Narrowing this needs a runtime probe of
// the ime inset, which cannot run before the first keyboard opens.
const ON_CREATE_ANCHOR = 'super.onCreate(null)'
const METHODS_ANCHOR = `  /**
   * Returns the name of the main component registered from JavaScript.`
const APPLY_ON_CREATE = `${ON_CREATE_ANCHOR}
    applyMultiWindowImeInsetCompatibility()`
const MULTI_WINDOW_METHODS = `  private fun applyMultiWindowImeInsetCompatibility() {
    androidx.core.view.WindowCompat.setDecorFitsSystemWindows(window, isInMultiWindowMode)
  }

  override fun onMultiWindowModeChanged(
    isInMultiWindowMode: Boolean,
    newConfig: android.content.res.Configuration
  ) {
    super.onMultiWindowModeChanged(isInMultiWindowMode, newConfig)
    applyMultiWindowImeInsetCompatibility()
  }

  // Why: API 24-25 only calls this deprecated single-arg overload, and configChanges keeps the
  // activity alive across the transition, so without it those devices never re-evaluate.
  @Deprecated("Deprecated in Java")
  override fun onMultiWindowModeChanged(isInMultiWindowMode: Boolean) {
    @Suppress("DEPRECATION")
    super.onMultiWindowModeChanged(isInMultiWindowMode)
    applyMultiWindowImeInsetCompatibility()
  }

${METHODS_ANCHOR}`

module.exports = function withAndroidFitSystemWindowsForIme(config) {
  return withMainActivity(config, (cfg) => {
    const contents = cfg.modResults.contents
    if (contents.includes('applyMultiWindowImeInsetCompatibility')) {
      return cfg
    }
    // Why: a silent no-op would ship an app whose split-screen keyboard is broken again, so fail
    // the prebuild if the template these anchors come from ever changes.
    for (const anchor of [ON_CREATE_ANCHOR, METHODS_ANCHOR]) {
      if (!contents.includes(anchor)) {
        throw new Error(
          `android-fit-system-windows-for-ime: MainActivity is missing the anchor ${JSON.stringify(anchor)}`
        )
      }
    }
    cfg.modResults.contents = contents
      .replace(ON_CREATE_ANCHOR, APPLY_ON_CREATE)
      .replace(METHODS_ANCHOR, MULTI_WINDOW_METHODS)
    return cfg
  })
}
