const { withAndroidStyles } = require('expo/config-plugins')

// Why: Android 15+ enforces edge-to-edge, which pins decorFitsSystemWindows=false and stops the
// system insetting the window for the IME. Opting out lets
// android-fit-system-windows-for-ime.js restore that inset in multi-window, where the shell owns
// the IME and reports no keyboard height at all. The opt-out is a window theme attribute (not a
// manifest attribute) and Android 16 ignores it above targetSdk 35, which is why
// expo-build-properties pins targetSdkVersion to 35 in app.json. The window is created with the
// splash theme and swapped to AppTheme afterwards, so both carry it.
const OPT_OUT_ATTRIBUTE = 'android:windowOptOutEdgeToEdgeEnforcement'
const THEMES_TO_OPT_OUT = ['AppTheme', 'Theme.App.SplashScreen']

module.exports = function withAndroidOptOutEdgeToEdgeEnforcement(config) {
  return withAndroidStyles(config, (cfg) => {
    const styles = cfg.modResults.resources.style ?? []
    const optedOut = []
    for (const style of styles) {
      if (!THEMES_TO_OPT_OUT.includes(style.$.name)) {
        continue
      }
      style.item = (style.item ?? []).filter((item) => item.$.name !== OPT_OUT_ATTRIBUTE)
      style.item.push({ $: { name: OPT_OUT_ATTRIBUTE }, _: 'true' })
      optedOut.push(style.$.name)
    }
    // Why: missing either theme leaves edge-to-edge enforced and silently reinstates the broken
    // split-screen keyboard, so fail the prebuild rather than the runtime.
    const missing = THEMES_TO_OPT_OUT.filter((name) => !optedOut.includes(name))
    if (missing.length > 0) {
      throw new Error(
        `android-optout-edge-to-edge-enforcement: styles.xml is missing ${missing.join(', ')}`
      )
    }
    return cfg
  })
}
