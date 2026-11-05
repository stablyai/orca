const { readdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { execFileSync } = require('node:child_process')

const MACOS_FOLDER_USAGE_DESCRIPTIONS = {
  NSDesktopFolderUsageDescription:
    "Orca allows terminal tools to access the user's Desktop folder when requested.",
  NSDocumentsFolderUsageDescription:
    "Orca allows terminal tools to access the user's Documents folder when requested.",
  NSDownloadsFolderUsageDescription:
    "Orca allows terminal tools to access the user's Downloads folder when requested."
}

function applyMacHelperFolderUsageDescriptions(appPath, productFilename, run = execFileSync) {
  const frameworks = join(appPath, 'Contents', 'Frameworks')
  for (const entry of readdirSync(frameworks, { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      !entry.name.startsWith(`${productFilename} Helper`) ||
      !entry.name.endsWith('.app')
    ) {
      continue
    }
    const plist = join(frameworks, entry.name, 'Contents', 'Info.plist')
    const info = JSON.parse(
      run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' })
    )
    if (!info || typeof info !== 'object' || Array.isArray(info)) {
      throw new Error('The packaged macOS Helper has an invalid Info.plist')
    }
    writeFileSync(plist, JSON.stringify({ ...info, ...MACOS_FOLDER_USAGE_DESCRIPTIONS }))
    run('/usr/bin/plutil', ['-convert', 'xml1', plist], { encoding: 'utf8' })
  }
}

module.exports = { MACOS_FOLDER_USAGE_DESCRIPTIONS, applyMacHelperFolderUsageDescriptions }
