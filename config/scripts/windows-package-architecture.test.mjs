import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { getWindowsInstallerArtifactName } = require('../windows-package-architecture.cjs')

describe('Windows package architecture', () => {
  it('gives native ARM64 installers a distinct name', () => {
    expect(getWindowsInstallerArtifactName({ ORCA_WINDOWS_ARM64_BUILD: '1' })).toBe(
      'orca-windows-setup-arm64.${ext}'
    )
    expect(getWindowsInstallerArtifactName({})).toBe('orca-windows-setup.${ext}')
  })
})
