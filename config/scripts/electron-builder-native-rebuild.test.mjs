import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  buildNativeRebuildArgs,
  runElectronBuilderNativeRebuild
} = require('./electron-builder-native-rebuild.cjs')

describe('electron-builder native rebuild hook', () => {
  it('passes the target platform and arch to Orca native rebuild script', () => {
    expect(
      buildNativeRebuildArgs({
        platform: { nodeName: 'darwin' },
        arch: 'x64'
      })
    ).toEqual([
      'config/scripts/rebuild-native-deps.mjs',
      '--platform=darwin',
      '--arch=x64',
      '--force'
    ])
  })

  it('returns false so electron-builder skips its optional module rebuild pass', () => {
    const calls = []
    const result = runElectronBuilderNativeRebuild(
      {
        platform: { nodeName: 'linux' },
        arch: 'arm64'
      },
      (...args) => calls.push(args)
    )

    expect(result).toBe(false)
    expect(calls).toEqual([
      [
        process.execPath,
        ['config/scripts/rebuild-native-deps.mjs', '--platform=linux', '--arch=arm64', '--force'],
        expect.objectContaining({ stdio: 'inherit' })
      ]
    ])
  })

  it('reuses a prepared native runtime only for the host target', () => {
    const runtime = {
      environment: { ORCA_REUSE_PREPARED_NATIVE_RUNTIME: '1' },
      hostPlatform: 'linux',
      hostArch: 'x64'
    }

    expect(
      buildNativeRebuildArgs(
        {
          platform: { nodeName: 'linux' },
          arch: 'x64'
        },
        runtime
      )
    ).toEqual(['config/scripts/rebuild-native-deps.mjs', '--platform=linux', '--arch=x64'])
    expect(
      buildNativeRebuildArgs(
        {
          platform: { nodeName: 'linux' },
          arch: 'arm64'
        },
        runtime
      )
    ).toContain('--force')
  })

  it('builds the native CLI launcher before packaging Windows resources', () => {
    const calls = []
    const result = runElectronBuilderNativeRebuild(
      {
        platform: { nodeName: 'win32' },
        arch: 'x64'
      },
      (...args) => calls.push(args)
    )

    expect(result).toBe(false)
    expect(calls).toEqual([
      [
        process.execPath,
        ['config/scripts/build-windows-cli-launcher.mjs'],
        expect.objectContaining({ stdio: 'inherit' })
      ],
      [
        process.execPath,
        ['config/scripts/rebuild-native-deps.mjs', '--platform=win32', '--arch=x64', '--force'],
        expect.objectContaining({ stdio: 'inherit' })
      ]
    ])
  })

  it('rejects incomplete electron-builder contexts', () => {
    expect(() => buildNativeRebuildArgs({ arch: 'x64' })).toThrow(/platform/)
    expect(() => buildNativeRebuildArgs({ platform: { nodeName: 'linux' } })).toThrow(/arch/)
  })
})
