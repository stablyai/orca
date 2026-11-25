const fs = require('node:fs')
const path = require('node:path')
const { withAndroidManifest, withDangerousMod, AndroidConfig } = require('expo/config-plugins')

// allowBackup="false" stops cloud backup but not Android 12+ device-to-device transfer, which copies filesDir.
// Page builds are re-downloadable and belong to this phone's pairings, so a new phone starts without them.
module.exports = function withAndroidDeviceTransferRules(config) {
  config = withDangerousMod(config, [
    'android',
    (cfg) => {
      const folder = path.join(cfg.modRequest.platformProjectRoot, 'app/src/main/res/xml')
      fs.mkdirSync(folder, { recursive: true })
      fs.writeFileSync(
        path.join(folder, 'data_extraction_rules.xml'),
        [
          '<?xml version="1.0" encoding="utf-8"?>',
          '<data-extraction-rules>',
          '  <device-transfer>',
          '    <exclude domain="file" path="mobile-web/"/>',
          '  </device-transfer>',
          '</data-extraction-rules>',
          ''
        ].join('\n')
      )
      return cfg
    }
  ])
  return withAndroidManifest(config, (cfg) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults)
    application.$['android:dataExtractionRules'] = '@xml/data_extraction_rules'
    return cfg
  })
}
