const { existsSync, renameSync } = require('node:fs')
const { join } = require('node:path')

function packageWindowsWerHelper(appOutDir, executableName) {
  const target = join(appOutDir, `${executableName}_wer.dll`)
  if (existsSync(target)) {
    return
  }
  const source = join(appOutDir, 'electron_wer.dll')
  if (!existsSync(source)) {
    throw new Error('Missing Electron Windows Error Reporting helper')
  }
  renameSync(source, target)
}

module.exports = { packageWindowsWerHelper }
