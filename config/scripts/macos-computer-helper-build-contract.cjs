const { execFileSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join } = require('node:path')

const MACOS_COMPUTER_HELPER_MINIMUM_VERSION = '12.0'
const MACOS_COMPUTER_HELPER_ARCHITECTURES = ['arm64', 'x86_64']

function verifyMacOSComputerHelperBuild(appPath, options = {}) {
  if (!existsSync(appPath)) {
    throw new Error(`Missing Orca Computer Use helper app at ${appPath}`)
  }
  const infoPlistPath = join(appPath, 'Contents', 'Info.plist')
  const executablePath = join(appPath, 'Contents', 'MacOS', 'orca-computer-use-macos')
  const plistMinimum = execFileSync(
    '/usr/bin/plutil',
    ['-extract', 'LSMinimumSystemVersion', 'raw', '-o', '-', infoPlistPath],
    { encoding: 'utf8' }
  ).trim()
  if (plistMinimum !== MACOS_COMPUTER_HELPER_MINIMUM_VERSION) {
    throw new Error(
      `Orca Computer Use plist minimum is ${plistMinimum}; expected ${MACOS_COMPUTER_HELPER_MINIMUM_VERSION}`
    )
  }
  if (options.productAppPath) {
    const productMinimum = execFileSync(
      '/usr/bin/plutil',
      [
        '-extract',
        'LSMinimumSystemVersion',
        'raw',
        '-o',
        '-',
        join(options.productAppPath, 'Contents', 'Info.plist')
      ],
      { encoding: 'utf8' }
    ).trim()
    if (productMinimum !== MACOS_COMPUTER_HELPER_MINIMUM_VERSION) {
      throw new Error(
        `Orca.app minimum is ${productMinimum}; expected ${MACOS_COMPUTER_HELPER_MINIMUM_VERSION}`
      )
    }
  }

  const architectures = execFileSync('/usr/bin/lipo', ['-archs', executablePath], {
    encoding: 'utf8'
  })
    .trim()
    .split(/\s+/)
    .sort()
  const expectedArchitectures = [...MACOS_COMPUTER_HELPER_ARCHITECTURES].sort()
  if (architectures.join(',') !== expectedArchitectures.join(',')) {
    throw new Error(
      `Orca Computer Use architectures are ${architectures.join(',')}; expected ${expectedArchitectures.join(',')}`
    )
  }

  for (const architecture of MACOS_COMPUTER_HELPER_ARCHITECTURES) {
    const build = execFileSync(
      '/usr/bin/xcrun',
      ['vtool', '-show-build', '-arch', architecture, executablePath],
      { encoding: 'utf8' }
    )
    const minimum = /^\s*minos\s+(\S+)$/m.exec(build)?.[1]
    if (minimum !== MACOS_COMPUTER_HELPER_MINIMUM_VERSION) {
      throw new Error(
        `Orca Computer Use ${architecture} minimum is ${minimum ?? 'missing'}; expected ${MACOS_COMPUTER_HELPER_MINIMUM_VERSION}`
      )
    }
  }

  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], {
    stdio: 'inherit'
  })
}

module.exports = {
  MACOS_COMPUTER_HELPER_ARCHITECTURES,
  MACOS_COMPUTER_HELPER_MINIMUM_VERSION,
  verifyMacOSComputerHelperBuild
}
