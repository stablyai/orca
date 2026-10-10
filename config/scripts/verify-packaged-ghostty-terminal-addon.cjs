const { existsSync } = require('node:fs')
const { join } = require('node:path')

const GHOSTTY_TERMINAL_ADDON = 'native/ghostty-terminal-macos/build/ghostty_terminal.node'

// Why: electron-builder only warns on a missing extraResources source, so a release built without
// `build:ghostty-terminal-macos` would ship with the native terminal setting silently inert.
function assertGhosttyTerminalAddonBuilt(
  electronPlatformName,
  { required, projectDir = join(__dirname, '..', '..') }
) {
  if (electronPlatformName !== 'darwin' || !required) {
    return
  }
  const addonPath = join(projectDir, GHOSTTY_TERMINAL_ADDON)
  if (!existsSync(addonPath)) {
    throw new Error(
      `Missing ${GHOSTTY_TERMINAL_ADDON}; run pnpm run build:ghostty-terminal-macos before packaging a macOS release.`
    )
  }
}

module.exports = { GHOSTTY_TERMINAL_ADDON, assertGhosttyTerminalAddonBuilt }
