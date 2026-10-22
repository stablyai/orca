import { describe, expect, it, vi } from 'vitest'
import {
  hasWindowsCompilerSelection,
  mergeWindowsCompilerEnvironment,
  parseWindowsCompilerEnvironment,
  prepareWindowsNodeRuntime
} from './initialize-windows-native-toolchain.mjs'

const receipt = [
  'Developer Command Prompt banner, not an environment variable',
  'TOKEN=should-not-be-exported',
  'ORCA_WINDOWS_NATIVE_ENVIRONMENT',
  'VCINSTALLDIR=C:\\Visual Studio\\VC\\',
  'VSCMD_VER=18.10.12224.181',
  'WindowsSDKVersion=10.0.28000.0\\',
  'VSCMD_ARG_TGT_ARCH=arm64',
  'Path=C:\\工具;C:\\Program Files\\Visual Studio',
  'INCLUDE=C:\\SDK=Custom\\Include',
  'TOKEN=should-not-be-exported',
  '=C:=C:\\',
  ''
].join('\r\n')

describe('Windows compiler environment receipt', () => {
  it('keeps compiler paths and equals signs while excluding unrelated variables and banners', () => {
    expect(parseWindowsCompilerEnvironment(receipt, 'arm64')).toEqual({
      VCINSTALLDIR: 'C:\\Visual Studio\\VC\\',
      VSCMD_VER: '18.10.12224.181',
      WindowsSDKVersion: '10.0.28000.0\\',
      VSCMD_ARG_TGT_ARCH: 'arm64',
      Path: 'C:\\工具;C:\\Program Files\\Visual Studio',
      INCLUDE: 'C:\\SDK=Custom\\Include'
    })
  })

  it.each([
    receipt.replace('ORCA_WINDOWS_NATIVE_ENVIRONMENT', 'missing'),
    receipt.replace('VCINSTALLDIR=', 'unrelated='),
    receipt.replace('VSCMD_VER=', 'unrelated='),
    receipt.replace('WindowsSDKVersion=', 'unrelated='),
    receipt.replace('10.0.28000.0\\', 'unavailable'),
    receipt.replace('18.10.12224.181', 'unavailable'),
    receipt.replace('VSCMD_ARG_TGT_ARCH=arm64', 'VSCMD_ARG_TGT_ARCH=x64')
  ])('rejects incomplete, invalid or wrong-architecture setup before use', (output) => {
    expect(() => parseWindowsCompilerEnvironment(output, 'arm64')).toThrow()
  })
})

describe('Windows native compiler environment scope', () => {
  it('replaces path keys case-insensitively without changing the parent environment', () => {
    const original = { PATH: 'original-path', LIB: 'original-lib', TOKEN: 'unchanged' }
    expect(
      mergeWindowsCompilerEnvironment(original, { Path: 'compiler-path', Lib: 'compiler-lib' })
    ).toEqual({ Path: 'compiler-path', Lib: 'compiler-lib', TOKEN: 'unchanged' })
    expect(original).toEqual({ PATH: 'original-path', LIB: 'original-lib', TOKEN: 'unchanged' })
  })

  it.each([
    'VCINSTALLDIR',
    'GYP_MSVS_VERSION',
    'npm_config_msvs_version',
    'npm_package_config_node_gyp_msvs_version'
  ])('retains an existing compiler selection through %s', (name) => {
    expect(hasWindowsCompilerSelection({ [name.toLowerCase()]: 'requested' })).toBe(true)
    expect(hasWindowsCompilerSelection({ [name]: '' })).toBe(false)
  })

  it('uses the original preparation and environment after a passing warm probe', () => {
    const runProcess = vi.fn(() => ({ code: 0 }))
    expect(prepareWindowsNodeRuntime(runProcess)).toBe(0)
    expect(runProcess).toHaveBeenCalledTimes(2)
    expect(runProcess).toHaveBeenLastCalledWith(
      expect.objectContaining({
        args: [expect.stringContaining('ensure-native-runtime.mjs'), '--runtime=node'],
        env: process.env,
        stdio: 'inherit'
      })
    )
  })

  it('propagates native preparation failure after a passing warm probe', () => {
    const runProcess = vi.fn().mockReturnValueOnce({ code: 0 }).mockReturnValueOnce({ code: 9 })
    expect(prepareWindowsNodeRuntime(runProcess)).toBe(9)
  })
})
