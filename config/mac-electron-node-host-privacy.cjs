const { execFileSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join } = require('node:path')

// The detached terminal daemon executes as Electron's generic Node helper, so
// protected-folder prompts are owned by this nested bundle rather than Orca.app.
const macTerminalProtectedFolderUsageDescriptions = {
  NSDesktopFolderUsageDescription:
    'Orca allows terminal-launched developer tools to access files on your Desktop when you request it.',
  NSDocumentsFolderUsageDescription:
    'Orca allows terminal-launched developer tools to access files in Documents when you request it.',
  NSDownloadsFolderUsageDescription:
    'Orca allows terminal-launched developer tools to access files in Downloads when you request it.'
}

function extendMacElectronNodeHostInfoPlist(appPath, productFilename) {
  const infoPlistPath = join(
    appPath,
    'Contents',
    'Frameworks',
    `${productFilename} Helper.app`,
    'Contents',
    'Info.plist'
  )
  if (!existsSync(infoPlistPath)) {
    throw new Error(`Missing Electron Node host Info.plist: ${infoPlistPath}`)
  }
  for (const [key, value] of Object.entries(macTerminalProtectedFolderUsageDescriptions)) {
    execFileSync('/usr/bin/plutil', ['-replace', key, '-string', value, infoPlistPath])
  }
  return infoPlistPath
}

module.exports = {
  extendMacElectronNodeHostInfoPlist,
  macTerminalProtectedFolderUsageDescriptions
}
