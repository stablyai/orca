const { join } = require('node:path')
const base = require(join(process.cwd(), 'config/electron-builder.config.cjs'))
const { signWindowsUninstallerViaSignPath } = require(
  join(process.cwd(), 'config/scripts/windows-uninstaller-signing.cjs')
)

// Load the release tag's packaging settings, including tags predating the relay hook.
module.exports = {
  ...base,
  win: {
    ...base.win,
    signtoolOptions: { ...base.win?.signtoolOptions, sign: signWindowsUninstallerViaSignPath }
  }
}
