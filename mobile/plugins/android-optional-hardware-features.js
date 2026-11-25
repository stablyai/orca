const { withAndroidManifest } = require('expo/config-plugins')

// Android implies these as required (Wi-Fi state permission, ML Kit's portrait-only scanner screens),
// so Play hides the app from devices without them and blocks production review. The app works without either.
const OPTIONAL_FEATURES = ['android.hardware.wifi', 'android.hardware.screen.portrait']

module.exports = function withAndroidOptionalHardwareFeatures(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest
    const features = (manifest['uses-feature'] ??= [])
    for (const name of OPTIONAL_FEATURES) {
      const existing = features.find((feature) => feature.$['android:name'] === name)
      if (existing) {
        existing.$['android:required'] = 'false'
      } else {
        features.push({ $: { 'android:name': name, 'android:required': 'false' } })
      }
    }
    return cfg
  })
}
