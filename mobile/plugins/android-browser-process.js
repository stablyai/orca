const { withMainApplication } = require('expo/config-plugins')

function guardBrowserProcessStartup(contents) {
  const guard =
    'if (android.os.Build.VERSION.SDK_INT >= 28 && android.app.Application.getProcessName() == "$packageName:orca_browser") return'
  for (const anchor of ['super.onCreate()', 'super.onConfigurationChanged(newConfig)']) {
    if (!contents.includes(`${anchor}\n    ${guard}`)) {
      if (!contents.includes(anchor)) {
        throw new Error(`Missing Android startup anchor: ${anchor}`)
      }
      contents = contents.replace(anchor, `${anchor}\n    ${guard}`)
    }
  }
  return contents
}

module.exports = function withAndroidBrowserProcess(config) {
  return withMainApplication(config, (cfg) => {
    cfg.modResults.contents = guardBrowserProcessStartup(cfg.modResults.contents)
    return cfg
  })
}
module.exports.guardBrowserProcessStartup = guardBrowserProcessStartup
