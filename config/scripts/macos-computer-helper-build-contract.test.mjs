import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MACOS_COMPUTER_HELPER_MINIMUM_VERSION,
  verifyMacOSComputerHelperBuild
} from './macos-computer-helper-build-contract.cjs'

describe.skipIf(process.platform !== 'darwin')('macOS Computer Use build contract', () => {
  it('verifies the staged signed universal helper metadata', () => {
    const appPath = join(
      import.meta.dirname,
      '..',
      '..',
      'native',
      'computer-use-macos',
      '.build',
      'release',
      'Orca Computer Use.app'
    )

    expect(() => verifyMacOSComputerHelperBuild(appPath)).not.toThrow()
  })

  it('rejects plist drift before inspecting binary slices', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-computer-helper-contract-'))
    const infoPlistPath = join(directory, 'Contents', 'Info.plist')
    try {
      mkdirSync(join(directory, 'Contents'), { recursive: true })
      const source = join(
        import.meta.dirname,
        '..',
        '..',
        'native',
        'computer-use-macos',
        '.build',
        'release',
        'Orca Computer Use.app',
        'Contents',
        'Info.plist'
      )
      const plist = readFileSync(source, 'utf8').replace(
        `<string>${MACOS_COMPUTER_HELPER_MINIMUM_VERSION}</string>`,
        '<string>99.0</string>'
      )
      writeFileSync(infoPlistPath, plist)

      expect(() => verifyMacOSComputerHelperBuild(directory)).toThrow(
        'Orca Computer Use plist minimum is 99.0'
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
