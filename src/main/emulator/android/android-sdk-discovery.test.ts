import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { discoverAndroidSdk } from './android-sdk-discovery'
import type { DiscoverAndroidSdkOptions } from './android-sdk-discovery'

// Fake `exists` predicate: only paths placed in the set are reported present.
const existsIn = (paths: Iterable<string>): ((path: string) => boolean) => {
  const set = new Set(paths)
  return (path: string) => set.has(path)
}

const adbFor = (sdkRoot: string, win32: boolean): string =>
  join(sdkRoot, 'platform-tools', win32 ? 'adb.exe' : 'adb')

const emulatorFor = (sdkRoot: string, win32: boolean): string =>
  join(sdkRoot, 'emulator', win32 ? 'emulator.exe' : 'emulator')

// discoverAndroidSdk requires both adb and the emulator binary to be present.
const sdkToolsFor = (sdkRoot: string, win32: boolean): string[] => [
  adbFor(sdkRoot, win32),
  emulatorFor(sdkRoot, win32)
]

describe('discoverAndroidSdk', () => {
  it('prefers ANDROID_HOME when its adb exists', () => {
    const sdkRoot = '/opt/android-home'
    const options: DiscoverAndroidSdkOptions = {
      env: { ANDROID_HOME: sdkRoot, ANDROID_SDK_ROOT: '/opt/android-sdk-root' },
      platform: 'linux',
      homedir: '/home/erik',
      exists: existsIn(sdkToolsFor(sdkRoot, false))
    }

    expect(discoverAndroidSdk(options)).toEqual({
      sdkRoot,
      adb: join(sdkRoot, 'platform-tools', 'adb'),
      emulator: join(sdkRoot, 'emulator', 'emulator'),
      avdmanager: join(sdkRoot, 'cmdline-tools', 'latest', 'bin', 'avdmanager')
    })
  })

  it('falls back to ANDROID_SDK_ROOT when ANDROID_HOME adb is missing', () => {
    const sdkRoot = '/opt/android-sdk-root'
    const result = discoverAndroidSdk({
      env: { ANDROID_HOME: '/opt/android-home', ANDROID_SDK_ROOT: sdkRoot },
      platform: 'linux',
      homedir: '/home/erik',
      exists: existsIn(sdkToolsFor(sdkRoot, false))
    })

    expect(result?.sdkRoot).toBe(sdkRoot)
  })

  it('ignores empty ANDROID_HOME / ANDROID_SDK_ROOT values', () => {
    const home = '/home/erik'
    const sdkRoot = join(home, 'Android', 'Sdk')
    const result = discoverAndroidSdk({
      env: { ANDROID_HOME: '', ANDROID_SDK_ROOT: '' },
      platform: 'linux',
      homedir: home,
      exists: existsIn(sdkToolsFor(sdkRoot, false))
    })

    expect(result?.sdkRoot).toBe(sdkRoot)
  })

  it('uses the darwin default SDK location with unsuffixed tools', () => {
    const home = '/Users/erik'
    const sdkRoot = join(home, 'Library', 'Android', 'sdk')
    const result = discoverAndroidSdk({
      env: {},
      platform: 'darwin',
      homedir: home,
      exists: existsIn(sdkToolsFor(sdkRoot, false))
    })

    expect(result).toEqual({
      sdkRoot,
      adb: join(sdkRoot, 'platform-tools', 'adb'),
      emulator: join(sdkRoot, 'emulator', 'emulator'),
      avdmanager: join(sdkRoot, 'cmdline-tools', 'latest', 'bin', 'avdmanager')
    })
  })

  it('uses the linux default SDK location', () => {
    const home = '/home/erik'
    const sdkRoot = join(home, 'Android', 'Sdk')
    const result = discoverAndroidSdk({
      env: {},
      platform: 'linux',
      homedir: home,
      exists: existsIn(sdkToolsFor(sdkRoot, false))
    })

    expect(result?.sdkRoot).toBe(sdkRoot)
    expect(result?.avdmanager).toBe(join(sdkRoot, 'cmdline-tools', 'latest', 'bin', 'avdmanager'))
  })

  it('uses the win32 default with LOCALAPPDATA and .exe/.bat tools', () => {
    const localAppData = 'C:\\Users\\erik\\AppData\\Local'
    const sdkRoot = join(localAppData, 'Android', 'Sdk')
    const result = discoverAndroidSdk({
      env: { LOCALAPPDATA: localAppData },
      platform: 'win32',
      homedir: 'C:\\Users\\erik',
      exists: existsIn(sdkToolsFor(sdkRoot, true))
    })

    expect(result).toEqual({
      sdkRoot,
      adb: join(sdkRoot, 'platform-tools', 'adb.exe'),
      emulator: join(sdkRoot, 'emulator', 'emulator.exe'),
      avdmanager: join(sdkRoot, 'cmdline-tools', 'latest', 'bin', 'avdmanager.bat')
    })
  })

  it('falls back to AppData\\Local on win32 when LOCALAPPDATA is unset', () => {
    const home = 'C:\\Users\\erik'
    const sdkRoot = join(home, 'AppData', 'Local', 'Android', 'Sdk')
    const result = discoverAndroidSdk({
      env: {},
      platform: 'win32',
      homedir: home,
      exists: existsIn(sdkToolsFor(sdkRoot, true))
    })

    expect(result?.sdkRoot).toBe(sdkRoot)
    expect(result?.adb).toBe(join(sdkRoot, 'platform-tools', 'adb.exe'))
  })

  it('returns null when no candidate adb exists', () => {
    const result = discoverAndroidSdk({
      env: { ANDROID_HOME: '/opt/a', ANDROID_SDK_ROOT: '/opt/b' },
      platform: 'linux',
      homedir: '/home/erik',
      exists: () => false
    })

    expect(result).toBeNull()
  })
})
