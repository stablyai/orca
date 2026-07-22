import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { inspectAndroidSetup, type AndroidSetupProbeOptions } from './android-setup-probe'

function probe(overrides: Partial<AndroidSetupProbeOptions> & { paths?: string[] } = {}) {
  const paths = new Set(overrides.paths ?? [])
  return inspectAndroidSetup({
    env: {},
    platform: 'darwin',
    homedir: '/Users/tester',
    exists: (path) => paths.has(path),
    hasInstalledSystemImage: (path) => paths.has(`${path}/package.xml`),
    backendAvailable: false,
    ...overrides
  })
}

function completeSdk(root: string, platform: NodeJS.Platform = 'darwin'): string[] {
  const suffix = platform === 'win32' ? '.exe' : ''
  return [
    root,
    join(root, 'platform-tools', `adb${suffix}`),
    join(root, 'emulator', `emulator${suffix}`),
    `${join(root, 'system-images')}/package.xml`
  ]
}

describe('inspectAndroidSetup', () => {
  it('distinguishes Android Studio missing from an SDK missing after Studio install', () => {
    expect(probe().message).toMatch(/Android Studio and the Android SDK/)
    expect(probe({ paths: ['/Applications/Android Studio.app'] })).toMatchObject({
      state: 'sdk-missing',
      studioInstalled: true,
      message: expect.stringContaining('SDK has not been installed')
    })
  })

  it('detects the standard macOS SDK path without ANDROID_HOME', () => {
    const root = '/Users/tester/Library/Android/sdk'
    expect(probe({ paths: completeSdk(root), backendAvailable: true })).toMatchObject({
      state: 'ready',
      sdkPath: root,
      configuredPath: false
    })
  })

  it('uses an app-configured custom SDK without mutating environment variables', () => {
    const root = '/Volumes/Tools/android-sdk'
    const env = { ANDROID_HOME: '/broken/environment/path' }
    expect(
      probe({ configuredPath: root, env, paths: completeSdk(root), backendAvailable: true })
    ).toMatchObject({ state: 'ready', sdkPath: root, configuredPath: true })
    expect(env.ANDROID_HOME).toBe('/broken/environment/path')
  })

  it('falls through a stale environment path to a complete standard SDK', () => {
    const root = '/Users/tester/Library/Android/sdk'
    expect(
      probe({
        env: { ANDROID_HOME: '/stale/sdk' },
        paths: ['/stale/sdk', ...completeSdk(root)],
        backendAvailable: true
      }).sdkPath
    ).toBe(root)
  })

  it('reports an invalid configured SDK instead of silently using another path', () => {
    expect(probe({ configuredPath: '/not-an-sdk' })).toMatchObject({
      state: 'sdk-invalid',
      sdkPath: '/not-an-sdk'
    })
  })

  it('identifies each incomplete SDK component and missing virtual device', () => {
    const root = '/Users/tester/Library/Android/sdk'
    expect(probe({ paths: [root] }).state).toBe('platform-tools-missing')
    expect(probe({ paths: [root, join(root, 'platform-tools', 'adb')] }).state).toBe(
      'emulator-missing'
    )
    expect(
      probe({
        paths: [root, join(root, 'platform-tools', 'adb'), join(root, 'emulator', 'emulator')]
      }).state
    ).toBe('system-image-missing')
    expect(probe({ paths: completeSdk(root) }).state).toBe('device-missing')
  })

  it('surfaces tool failures instead of mislabeling them as a missing device', () => {
    const root = '/Users/tester/Library/Android/sdk'
    expect(
      probe({
        paths: completeSdk(root),
        backendMessage: 'adb server failed to start'
      }).state
    ).toBe('error')
  })

  it.each([
    ['linux', '/home/tester/Android/Sdk'],
    ['win32', join('C:\\Users\\tester', 'AppData', 'Local', 'Android', 'Sdk')]
  ] as const)('uses the standard %s SDK location', (platform, root) => {
    const env =
      platform === 'win32' ? { LOCALAPPDATA: join('C:\\Users\\tester', 'AppData', 'Local') } : {}
    expect(
      probe({
        platform,
        homedir: platform === 'win32' ? 'C:\\Users\\tester' : '/home/tester',
        env,
        paths: completeSdk(root, platform),
        backendAvailable: true
      }).sdkPath
    ).toBe(root)
  })
})
