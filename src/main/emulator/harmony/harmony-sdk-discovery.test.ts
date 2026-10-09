import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { discoverHarmonySdk } from './harmony-sdk-discovery'
import type { DiscoverHarmonySdkOptions } from './harmony-sdk-discovery'

// Fake `exists`: only paths placed in the set are reported present.
const existsIn = (paths: Iterable<string>): ((path: string) => boolean) => {
  const set = new Set(paths)
  return (path: string) => set.has(path)
}

// The standard DevEco layout used by most candidates: bundled hdc + tools/emulator/Emulator.
function standardTools(sdkRoot: string, win32: boolean): string[] {
  const exe = win32 ? '.exe' : ''
  return [
    join(sdkRoot, 'sdk', 'default', 'openharmony', 'toolchains', `hdc${exe}`),
    join(sdkRoot, 'tools', 'emulator', `Emulator${exe}`)
  ]
}

const baseOptions = {
  env: {},
  homedir: '/home/erik'
}

describe('discoverHarmonySdk', () => {
  it('prefers HOS_SDK_HOME and returns the standard layout', () => {
    const sdkRoot = '/opt/hos-sdk'
    const result = discoverHarmonySdk({
      ...baseOptions,
      env: { HOS_SDK_HOME: sdkRoot, DEVECO_SDK_HOME: '/opt/deveco' },
      platform: 'linux',
      exists: existsIn(standardTools(sdkRoot, false))
    })

    expect(result).toEqual({
      sdkRoot,
      hdc: join(sdkRoot, 'sdk', 'default', 'openharmony', 'toolchains', 'hdc'),
      emulator: join(sdkRoot, 'tools', 'emulator', 'Emulator')
    })
  })

  it('falls back through the env var order when earlier roots lack tools', () => {
    const sdkRoot = '/opt/ohos'
    const result = discoverHarmonySdk({
      ...baseOptions,
      env: { HOS_SDK_HOME: '/opt/a', DEVECO_SDK_HOME: '/opt/b', OHOS_SDK_HOME: sdkRoot },
      platform: 'linux',
      exists: existsIn(standardTools(sdkRoot, false))
    })

    expect(result?.sdkRoot).toBe(sdkRoot)
  })

  it('treats a .app env path as its Contents dir, then the bare path', () => {
    const sdkRoot = '/Applications/DevEco-Studio.app'
    const contents = join(sdkRoot, 'Contents')
    const result = discoverHarmonySdk({
      ...baseOptions,
      env: { HOS_SDK_HOME: sdkRoot },
      platform: 'darwin',
      exists: existsIn(standardTools(contents, false))
    })

    expect(result?.sdkRoot).toBe(contents)
  })

  it('uses the darwin default install location', () => {
    const sdkRoot = '/Applications/DevEco-Studio.app/Contents'
    const result = discoverHarmonySdk({
      env: {},
      platform: 'darwin',
      homedir: '/Users/erik',
      exists: existsIn(standardTools(sdkRoot, false))
    })

    expect(result?.sdkRoot).toBe(sdkRoot)
  })

  it('uses linux default roots', () => {
    const home = '/home/erik'
    const sdkRoot = join(home, 'command-line-tools')
    const exe = ''
    // command-line-tools layout uses a loose emulator/Emulator with toolchains hdc.
    const tools = [
      join(sdkRoot, 'toolchains', `hdc${exe}`),
      join(sdkRoot, 'emulator', `Emulator${exe}`)
    ]
    const result = discoverHarmonySdk({
      env: {},
      platform: 'linux',
      homedir: home,
      exists: existsIn(tools)
    })

    expect(result).toEqual({
      sdkRoot,
      hdc: join(sdkRoot, 'toolchains', 'hdc'),
      emulator: join(sdkRoot, 'emulator', 'Emulator')
    })
  })

  it('uses win32 defaults and .exe tool names', () => {
    const localAppData = 'C:\\Users\\erik\\AppData\\Local'
    const sdkRoot = join(localAppData, 'Huawei', 'Sdk')
    const result = discoverHarmonySdk({
      env: { LOCALAPPDATA: localAppData },
      platform: 'win32',
      homedir: 'C:\\Users\\erik',
      exists: existsIn(standardTools(sdkRoot, true))
    })

    expect(result).toEqual({
      sdkRoot,
      hdc: join(sdkRoot, 'sdk', 'default', 'openharmony', 'toolchains', 'hdc.exe'),
      emulator: join(sdkRoot, 'tools', 'emulator', 'Emulator.exe')
    })
  })

  it('rejects a partial toolchain where only hdc exists', () => {
    const sdkRoot = '/opt/hos-sdk'
    const [hdc] = standardTools(sdkRoot, false)
    const result = discoverHarmonySdk({
      ...baseOptions,
      env: { HOS_SDK_HOME: sdkRoot },
      platform: 'linux',
      exists: existsIn([hdc])
    })

    expect(result).toBeNull()
  })

  it('returns null when no candidate has both tools', () => {
    const options: DiscoverHarmonySdkOptions = {
      env: { HOS_SDK_HOME: '/opt/a' },
      platform: 'linux',
      homedir: '/home/erik',
      exists: () => false
    }

    expect(discoverHarmonySdk(options)).toBeNull()
  })
})
