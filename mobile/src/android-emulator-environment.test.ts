import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  describeBuildJdkSupport,
  findBootedEmulatorSerial,
  parseAvdNames,
  parseJavaMajorVersion,
  parseRunningAvdName,
  resolveAndroidAvdHome,
  resolveAndroidSdkRoot,
  resolveAndroidToolPath,
  selectAvdName,
  type AndroidEnvironment
} from '../scripts/android-emulator-environment'

function environment(overrides: Partial<AndroidEnvironment> = {}): AndroidEnvironment {
  return {
    env: {},
    homeDir: path.join(path.sep, 'home', 'dev'),
    platform: 'linux',
    ...overrides
  }
}

describe('android emulator environment', () => {
  it('Given ANDROID_HOME When resolving the SDK root Then it wins over the platform default', () => {
    // Given / When
    const root = resolveAndroidSdkRoot(
      environment({ env: { ANDROID_HOME: '/opt/sdk', ANDROID_SDK_ROOT: '/other/sdk' } })
    )

    // Then
    expect(root).toBe('/opt/sdk')
  })

  it('Given no SDK variables When resolving the SDK root Then each platform gets its documented default', () => {
    // Given / When / Then
    expect(resolveAndroidSdkRoot(environment({ platform: 'darwin' }))).toBe(
      path.join(path.sep, 'home', 'dev', 'Library', 'Android', 'sdk')
    )
    expect(resolveAndroidSdkRoot(environment({ platform: 'linux' }))).toBe(
      path.join(path.sep, 'home', 'dev', 'Android', 'Sdk')
    )
    expect(
      resolveAndroidSdkRoot(
        environment({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' } })
      )
    ).toBe(path.join('C:\\Users\\dev\\AppData\\Local', 'Android', 'Sdk'))
  })

  // Why: this is the trap that makes a freshly created AVD invisible — avdmanager
  // writes it under XDG while the emulator looks in ~/.android.
  it('Given XDG_CONFIG_HOME When resolving the AVD home Then it follows avdmanager rather than ~/.android', () => {
    // Given / When
    const avdHome = resolveAndroidAvdHome(
      environment({ env: { XDG_CONFIG_HOME: path.join(path.sep, 'home', 'dev', '.config') } })
    )

    // Then
    expect(avdHome).toBe(path.join(path.sep, 'home', 'dev', '.config', '.android', 'avd'))
  })

  it('Given AVD home overrides When resolving Then the documented precedence wins', () => {
    // Given / When / Then: ANDROID_EMULATOR_HOME replaces ~/.android per
    // `emulator -help-environment`, so it outranks the XDG fallback.
    expect(
      resolveAndroidAvdHome(
        environment({
          env: {
            ANDROID_AVD_HOME: '/explicit/avd',
            ANDROID_EMULATOR_HOME: '/emulator/.android',
            ANDROID_USER_HOME: '/user/.android',
            XDG_CONFIG_HOME: '/xdg'
          }
        })
      )
    ).toBe('/explicit/avd')
    expect(
      resolveAndroidAvdHome(
        environment({
          env: {
            ANDROID_EMULATOR_HOME: '/emulator/.android',
            ANDROID_USER_HOME: '/user/.android',
            XDG_CONFIG_HOME: '/xdg'
          }
        })
      )
    ).toBe(path.join('/emulator/.android', 'avd'))
    expect(
      resolveAndroidAvdHome(
        environment({ env: { ANDROID_USER_HOME: '/user/.android', XDG_CONFIG_HOME: '/xdg' } })
      )
    ).toBe(path.join('/user/.android', 'avd'))
    expect(resolveAndroidAvdHome(environment())).toBe(
      path.join(path.sep, 'home', 'dev', '.android', 'avd')
    )
  })

  // Why: shells export empty overrides all the time (`export X=$UNSET`), and a
  // nullish fallback would hand the emulator the relative path './avd'.
  it('Given empty AVD overrides When resolving Then they fall through to the home default', () => {
    // Given / When / Then
    expect(
      resolveAndroidAvdHome(
        environment({
          env: { ANDROID_AVD_HOME: '', ANDROID_EMULATOR_HOME: '', ANDROID_USER_HOME: '' }
        })
      )
    ).toBe(path.join(path.sep, 'home', 'dev', '.android', 'avd'))
    expect(
      resolveAndroidAvdHome(
        environment({ env: { ANDROID_EMULATOR_HOME: '', ANDROID_USER_HOME: '/user/.android' } })
      )
    ).toBe(path.join('/user/.android', 'avd'))
  })

  it('Given a Windows SDK When resolving tool paths Then binaries and wrappers get their own suffix', () => {
    // Given
    const win = environment({ platform: 'win32', env: { ANDROID_HOME: 'C:\\sdk' } })

    // When / Then
    expect(resolveAndroidToolPath(win, 'adb')).toBe(
      path.join('C:\\sdk', 'platform-tools', 'adb.exe')
    )
    expect(resolveAndroidToolPath(win, 'avdmanager')).toBe(
      path.join('C:\\sdk', 'cmdline-tools', 'latest', 'bin', 'avdmanager.bat')
    )
    expect(resolveAndroidToolPath(environment({ env: { ANDROID_HOME: '/sdk' } }), 'emulator')).toBe(
      path.join('/sdk', 'emulator', 'emulator')
    )
  })

  it('Given emulator warnings in the AVD listing When parsing Then only AVD names survive', () => {
    // Given: the emulator binary prefixes advice lines onto stdout
    const stdout = [
      'INFO    | Storing crashdata in: /tmp/avd',
      'emulator: WARNING: encryption is off',
      'orca-jp',
      'Pixel_7_API_36',
      ''
    ].join('\n')

    // When / Then
    expect(parseAvdNames(stdout)).toEqual(['orca-jp', 'Pixel_7_API_36'])
  })

  it('Given AVD names When selecting Then exact beats partial and a miss is reported', () => {
    // Given
    const names = ['orca-jp', 'Pixel_7_API_36']

    // When / Then
    expect(selectAvdName(names)).toBe('orca-jp')
    expect(selectAvdName(names, 'Pixel_7_API_36')).toBe('Pixel_7_API_36')
    expect(selectAvdName(names, 'pixel')).toBe('Pixel_7_API_36')
    expect(selectAvdName(names, 'nexus')).toBeNull()
    expect(selectAvdName([], 'orca-jp')).toBeNull()
  })

  it('Given a device list with a still-booting emulator When finding a serial Then only a ready device matches', () => {
    // Given
    const booting = 'List of devices attached\nemulator-5554\toffline\n'
    const ready = 'List of devices attached\nemulator-5554\toffline\nemulator-5556\tdevice\n'

    // When / Then
    expect(findBootedEmulatorSerial(booting)).toBeNull()
    expect(findBootedEmulatorSerial(ready)).toBe('emulator-5556')
    // A physical handset is not an emulator and must not be picked up silently.
    expect(findBootedEmulatorSerial('List of devices attached\nR5CT30ABCDE\tdevice\n')).toBeNull()
  })

  it('Given adb emu avd name output When parsing Then the acknowledgement is not mistaken for a name', () => {
    // Given / When / Then
    expect(parseRunningAvdName('orca-jp\nOK\n')).toBe('orca-jp')
    expect(parseRunningAvdName('OK\n')).toBeNull()
    expect(parseRunningAvdName('')).toBeNull()
  })

  it('Given java -version output When parsing Then both modern and 1.x schemes resolve', () => {
    // Given / When / Then
    expect(parseJavaMajorVersion('openjdk version "17.0.20" 2026-07-21')).toBe(17)
    expect(parseJavaMajorVersion('openjdk version "25.0.2" 2026-01-20')).toBe(25)
    expect(parseJavaMajorVersion('java version "1.8.0_401"')).toBe(8)
    expect(parseJavaMajorVersion('no java here')).toBeNull()
  })

  // Why: JDK 25 is the failure I hit — Gradle 9 aborts configureCMakeDebug with a
  // restricted-method error, which reads as an unrelated native build failure.
  it('Given a build JDK When describing support Then only the workable range passes silently', () => {
    // Given / When / Then
    expect(describeBuildJdkSupport(17)).toBeNull()
    expect(describeBuildJdkSupport(21)).toBeNull()
    expect(describeBuildJdkSupport(25)).toContain('JDK 17')
    expect(describeBuildJdkSupport(11)).toContain('too old')
    expect(describeBuildJdkSupport(null)).toContain('needs a JDK')
  })
})
