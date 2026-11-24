const { AndroidConfig, withStringsXml } = require('expo/config-plugins')

// Why: the new app (dev.orca.app) installs next to this one, so the old GitHub app's launcher
// label says which icon the move screen's "Delete this app" step means. iOS keeps its name.
const RETIRED_ANDROID_PACKAGE = 'com.stably.orca.mobile'
const RETIRED_APP_LABEL = 'Orca (old)'

module.exports = function withAndroidRetiredAppName(config) {
  if (config.android?.package !== RETIRED_ANDROID_PACKAGE) {
    return config
  }
  return withStringsXml(config, (mod) => {
    mod.modResults = AndroidConfig.Strings.setStringItem(
      [AndroidConfig.Resources.buildResourceItem({ name: 'app_name', value: RETIRED_APP_LABEL })],
      mod.modResults
    )
    return mod
  })
}
