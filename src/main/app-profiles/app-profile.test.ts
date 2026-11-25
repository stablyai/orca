import { describe, expect, it } from 'vitest'
import { isAppProfileRuntime, resolveAppProfile, userDataDirArg } from './app-profile'

const plist = (entries: Record<string, string>): string =>
  `<plist><dict>${Object.entries(entries)
    .map(([key, value]) => `<key>${key}</key>\n\t<string>${value}</string>`)
    .join('')}</dict></plist>`

const profilePlist = plist({
  CFBundleIdentifier: 'com.stablyai.orca.profile.work',
  CFBundleDisplayName: 'Orca - Work',
  OrcaAppProfileId: 'work'
})

describe('resolveAppProfile', () => {
  it('takes the profile from the bundle and its folder under the profiles root', () => {
    expect(
      resolveAppProfile({
        plist: profilePlist,
        userDataDirArg: null,
        defaultRoot: '/root',
        readMarker: () => null
      })
    ).toEqual({
      id: 'work',
      name: 'Orca - Work',
      bundleId: 'com.stablyai.orca.profile.work',
      userDataPath: '/root/work'
    })
  })

  it('uses the test root from the bundle and --user-data-dir before the root', () => {
    const withRoot = profilePlist.replace(
      '</dict>',
      '<key>OrcaAppProfilesRoot</key><string>/test root</string></dict>'
    )
    const input = { plist: withRoot, defaultRoot: '/root', readMarker: () => 'work' }
    expect(resolveAppProfile({ ...input, userDataDirArg: null })?.userDataPath).toBe(
      '/test root/work'
    )
    expect(resolveAppProfile({ ...input, userDataDirArg: '/given' })?.userDataPath).toBe('/given')
  })

  it('stops when the bundle and the marker name different profiles', () => {
    expect(() =>
      resolveAppProfile({
        plist: profilePlist,
        userDataDirArg: '/x',
        defaultRoot: '/root',
        readMarker: () => 'home'
      })
    ).toThrow('is the profile "home"')
  })

  it('stops when a given folder has no marker: it never takes the default folder', () => {
    // `orca --profile default serve` from a profile terminal must not mark the default folder.
    expect(() =>
      resolveAppProfile({
        plist: profilePlist,
        userDataDirArg: '/Library/Application Support/orca',
        defaultRoot: '/root',
        readMarker: () => null
      })
    ).toThrow('is not this profile')
  })

  it('finds a profile served by the default executable through the marker only', () => {
    const defaultPlist = plist({ CFBundleIdentifier: 'com.stablyai.orca' })
    const readMarker = (path: string): string | null => (path === '/root/work' ? 'work' : null)
    expect(
      resolveAppProfile({
        plist: defaultPlist,
        userDataDirArg: '/root/work',
        defaultRoot: '/root',
        readMarker
      })
    ).toMatchObject({ id: 'work', bundleId: 'com.stablyai.orca', userDataPath: '/root/work' })
    expect(
      resolveAppProfile({
        plist: defaultPlist,
        userDataDirArg: '/other',
        defaultRoot: '/root',
        readMarker
      })
    ).toBeNull()
    // The default userData folder is never read: the app does not know it yet.
    expect(
      resolveAppProfile({
        plist: defaultPlist,
        userDataDirArg: null,
        defaultRoot: '/root',
        readMarker
      })
    ).toBeNull()
  })
})

describe('isAppProfileRuntime', () => {
  it('follows ORCA_HOME_DIR only, which each Orca entry point sets or clears', () => {
    expect(isAppProfileRuntime({ ORCA_HOME_DIR: '/profiles/work/orca-home' })).toBe(true)
    expect(isAppProfileRuntime({ ORCA_USER_DATA_PATH: '/profiles/work' })).toBe(false)
  })
})

describe('userDataDirArg', () => {
  it('takes the last --user-data-dir, as Chromium does', () => {
    expect(userDataDirArg(['Orca', '--user-data-dir=/a', '--user-data-dir=/b'])).toBe('/b')
    expect(userDataDirArg(['Orca', '--user-data-dir='])).toBeNull()
    expect(userDataDirArg(['Orca'])).toBeNull()
  })
})
