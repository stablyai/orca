const { withAndroidManifest, AndroidConfig } = require('expo/config-plugins')

// Expo orientation=unspecified still rotates despite Android lock; fullUser honors lock while allowing all orientations when unlocked, matching iOS.
const ANDROID_SCREEN_ORIENTATION = 'fullUser'

module.exports = function withAndroidRespectRotationLock(config) {
  return withAndroidManifest(config, (cfg) => {
    const activity = AndroidConfig.Manifest.getMainActivityOrThrow(cfg.modResults)
    activity.$['android:screenOrientation'] = ANDROID_SCREEN_ORIENTATION
    return cfg
  })
}
