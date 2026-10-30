const fs = require('node:fs')
const path = require('node:path')
const { withAndroidManifest, withDangerousMod, AndroidConfig } = require('expo/config-plugins')

// Declares the Android 13+ per-app language list. expo-localization's own Android option also
// strips every other language from dependency resources, so only its iOS half is used.
module.exports = function withAndroidLocaleConfig(config, { locales }) {
  config = withDangerousMod(config, [
    'android',
    (cfg) => {
      const folder = path.join(cfg.modRequest.platformProjectRoot, 'app/src/main/res/xml')
      fs.mkdirSync(folder, { recursive: true })
      fs.writeFileSync(
        path.join(folder, 'locales_config.xml'),
        [
          '<?xml version="1.0" encoding="utf-8"?>',
          '<locale-config xmlns:android="http://schemas.android.com/apk/res/android">',
          ...locales.map((locale) => `  <locale android:name="${locale}"/>`),
          '</locale-config>',
          ''
        ].join('\n')
      )
      return cfg
    }
  ])
  return withAndroidManifest(config, (cfg) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults)
    application.$['android:localeConfig'] = '@xml/locales_config'
    return cfg
  })
}
