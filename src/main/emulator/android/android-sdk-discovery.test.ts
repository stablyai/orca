import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { discoverAndroidSdk } from './android-sdk-discovery'

const home = '/home/dev'
const defaultRoot = join(home, 'Android', 'Sdk')
const adbIn = (root: string): string => join(root, 'platform-tools', 'adb')
const emulatorIn = (root: string): string => join(root, 'emulator', 'emulator')

function discover(files: string[], env: NodeJS.ProcessEnv = {}, pathAdb: string | null = null) {
  const present = new Set(files)
  return discoverAndroidSdk({
    env,
    platform: 'linux',
    homedir: home,
    exists: (path) => present.has(path),
    findAdbOnPath: () => pathAdb
  })
}

describe('discoverAndroidSdk', () => {
  it('accepts an SDK root with platform-tools but no emulator package', () => {
    expect(discover([adbIn(defaultRoot)])).toEqual({
      sdkRoot: defaultRoot,
      adb: adbIn(defaultRoot),
      emulator: null
    })
  })

  it('prefers a full SDK over an earlier adb-only root', () => {
    const adbOnly = '/opt/platform-tools-only'
    expect(
      discover([adbIn(adbOnly), adbIn(defaultRoot), emulatorIn(defaultRoot)], {
        ANDROID_HOME: adbOnly
      })
    ).toEqual({ sdkRoot: defaultRoot, adb: adbIn(defaultRoot), emulator: emulatorIn(defaultRoot) })
  })

  it('falls back to a standalone adb on PATH when no SDK root has one', () => {
    expect(discover([], {}, '/usr/bin/adb')).toEqual({
      sdkRoot: null,
      adb: '/usr/bin/adb',
      emulator: null
    })
    expect(discover([])).toBeNull()
  })
})
