const { withAppBuildGradle } = require('expo/config-plugins')

const MARKER = '// android-drop-iroh-desktop-natives'
// computer.iroh:iroh bundles macOS, Linux and Windows libiroh_ffi (~65 MB) as Java resources;
// Android loads the per-ABI .so from iroh-android instead.
const EXCLUDES = ['darwin-aarch64/**', 'linux-aarch64/**', 'linux-x86-64/**', 'win32-x86-64/**']

module.exports = function withAndroidDropIrohDesktopNatives(config) {
  return withAppBuildGradle(config, (cfg) => {
    if (!cfg.modResults.contents.includes(MARKER)) {
      const list = EXCLUDES.map((entry) => `'${entry}'`).join(', ')
      cfg.modResults.contents += `\n${MARKER}\nandroid {\n  packagingOptions {\n    resources {\n      excludes += [${list}]\n    }\n  }\n}\n`
    }
    return cfg
  })
}
