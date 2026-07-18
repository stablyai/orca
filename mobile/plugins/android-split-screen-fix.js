const { withAndroidManifest, AndroidConfig } = require('expo/config-plugins')

// Why: Samsung OneUI and other Android skins require explicit multi-window
// support declarations. Without android:resizeableActivity="true", split-screen
// and freeform windowing either refuse to launch or render the activity in
// an incorrectly sized container (letterboxing instead of filling the split).
// Additionally, screenSize and smallestScreenSize must be present in
// android:configChanges so the app does not restart on every split resize.
module.exports = function withAndroidSplitScreenFix(config) {
  return withAndroidManifest(config, (cfg) => {
    const activity = AndroidConfig.Manifest.getMainActivityOrThrow(cfg.modResults)

    // 1. Explicitly declare the activity supports multi-window / split-screen.
    activity.$['android:resizeableActivity'] = 'true'

    // 2. Ensure configChanges include size-related keys. This prevents the
    //    activity from being destroyed and recreated when the user drags the
    //    split divider, which is the main cause of the "not filling" visual bug.
    const existingConfigChanges = activity.$['android:configChanges'] || ''
    const changesSet = new Set(
      existingConfigChanges
        .split('|')
        .map((s) => s.trim())
        .filter(Boolean)
    )
    const requiredChanges = [
      'screenSize',
      'smallestScreenSize',
      'density',
      'orientation',
      'screenLayout'
    ]
    for (const change of requiredChanges) {
      changesSet.add(change)
    }
    activity.$['android:configChanges'] = Array.from(changesSet).join('|')

    return cfg
  })
}
