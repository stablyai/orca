import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  buildNativeRebuildArgs,
  runElectronBuilderNativeRebuild
} = require('./electron-builder-native-rebuild.cjs')

describe('electron-builder native rebuild hook', () => {
  it('refuses ARM64 packaging with x64 installer metadata before building', () => {
    expect(() =>
      runElectronBuilderNativeRebuild(
        { platform: { nodeName: 'win32' }, arch: 'arm64' },
        () => {
          throw new Error('native build started')
        },
        { environment: {} }
      )
    ).toThrow('ORCA_WINDOWS_ARM64_BUILD must be 1 for a Windows arm64 package')
  })

  it('rejects incomplete electron-builder contexts', () => {
    expect(() => buildNativeRebuildArgs({ arch: 'x64' })).toThrow(/platform/)
    expect(() => buildNativeRebuildArgs({ platform: { nodeName: 'linux' } })).toThrow(/arch/)
  })
})
