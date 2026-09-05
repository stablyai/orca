import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const {
  buildNativeRebuildArgs,
  runElectronBuilderNativeRebuild,
  shouldStageWindowsNodePtyPrebuild
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
      (...args) => calls.push(args),
      { environment: {} }
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

  it('stages a verified prebuild for cross-architecture Windows packages', () => {
    const calls = []
    const result = runElectronBuilderNativeRebuild(
      {
        platform: { nodeName: 'win32' },
        arch: 'arm64'
      },
      (...args) => calls.push(args),
      { environment: { ORCA_WINDOWS_ARM64_BUILD: '1' } }
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
        ['config/scripts/stage-windows-node-pty-prebuild.mjs', '--arch=arm64'],
        expect.objectContaining({ stdio: 'inherit' })
      ]
    ])
  })

  it('stages every Windows ARM64 package independently of the host architecture', () => {
    expect(shouldStageWindowsNodePtyPrebuild('win32', 'arm64')).toBe(true)
    expect(shouldStageWindowsNodePtyPrebuild('win32', 'x64')).toBe(false)
    expect(shouldStageWindowsNodePtyPrebuild('linux', 'arm64')).toBe(false)
  })

  it('rejects Windows target and resource architecture mismatches', () => {
    expect(() =>
      runElectronBuilderNativeRebuild(
        { platform: { nodeName: 'win32' }, arch: 'arm64' },
        vi.fn(),
        { environment: {} }
      )
    ).toThrow(/ORCA_WINDOWS_ARM64_BUILD/)
    expect(() =>
      runElectronBuilderNativeRebuild(
        { platform: { nodeName: 'win32' }, arch: 'x64' },
        vi.fn(),
        { environment: { ORCA_WINDOWS_ARM64_BUILD: '1' } }
      )
    ).toThrow(/ORCA_WINDOWS_ARM64_BUILD/)
  })

  it('rejects incomplete electron-builder contexts', () => {
    expect(() => buildNativeRebuildArgs({ arch: 'x64' })).toThrow(/platform/)
    expect(() => buildNativeRebuildArgs({ platform: { nodeName: 'linux' } })).toThrow(/arch/)
  })
})
