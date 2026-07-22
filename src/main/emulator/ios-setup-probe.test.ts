import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { inspectIosSetup, type IosSetupProbeOptions } from './ios-setup-probe'

const DEFAULT_APP = '/Applications/Xcode.app'
const DEFAULT_DEVELOPER_DIR = join(DEFAULT_APP, 'Contents', 'Developer')
const IOS_DEVICE_JSON = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
      { name: 'iPhone 16', udid: 'device-1', state: 'Shutdown', isAvailable: true }
    ]
  }
})
const IOS_RUNTIME_JSON = JSON.stringify({
  runtimes: [{ identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-0', isAvailable: true }]
})

type ProbeScenario = {
  platform?: NodeJS.Platform
  selected?: string
  apps?: string[]
  firstLaunch?: { ok: boolean; stderr?: string }
  devices?: { ok: boolean; stdout?: string; stderr?: string }
  runtimes?: { ok: boolean; stdout?: string }
  spotlight?: string[]
}

function scenarioOptions(scenario: ProbeScenario): IosSetupProbeOptions {
  const apps = scenario.apps ?? []
  const toolPaths = new Set(
    apps.map((app) => join(app, 'Contents', 'Developer', 'usr', 'bin', 'xcodebuild'))
  )
  return {
    platform: scenario.platform ?? 'darwin',
    homedir: '/Users/tester',
    exists: (path) => toolPaths.has(path),
    listDirectory: (path) =>
      path === '/Applications'
        ? apps
            .filter((app) => app.startsWith('/Applications/'))
            .map((app) => app.slice('/Applications/'.length))
        : [],
    run: async (file, args) => {
      if (file === '/usr/bin/xcode-select') {
        return {
          ok: true,
          stdout: `${scenario.selected ?? '/Library/Developer/CommandLineTools'}\n`,
          stderr: ''
        }
      }
      if (file === '/usr/bin/mdfind') {
        return { ok: true, stdout: (scenario.spotlight ?? []).join('\n'), stderr: '' }
      }
      if (args[0] === '-checkFirstLaunchStatus') {
        return {
          ok: scenario.firstLaunch?.ok ?? true,
          stdout: '',
          stderr: scenario.firstLaunch?.stderr ?? ''
        }
      }
      if (args.includes('devices')) {
        return {
          ok: scenario.devices?.ok ?? true,
          stdout: scenario.devices?.stdout ?? IOS_DEVICE_JSON,
          stderr: scenario.devices?.stderr ?? ''
        }
      }
      return {
        ok: scenario.runtimes?.ok ?? true,
        stdout: scenario.runtimes?.stdout ?? IOS_RUNTIME_JSON,
        stderr: ''
      }
    }
  }
}

describe('inspectIosSetup', () => {
  it('reports Xcode missing', async () => {
    expect((await inspectIosSetup(scenarioOptions({ apps: [] }))).state).toBe('xcode-missing')
  })

  it('detects full Xcode while standalone Command Line Tools remain selected', async () => {
    const result = await inspectIosSetup(scenarioOptions({ apps: [DEFAULT_APP] }))
    expect(result).toMatchObject({
      state: 'xcode-selection-required',
      selectedDeveloperDir: '/Library/Developer/CommandLineTools',
      recommendedXcode: { appPath: DEFAULT_APP, developerDir: DEFAULT_DEVELOPER_DIR }
    })
  })

  it('separates pending license and first-launch components', async () => {
    const result = await inspectIosSetup(
      scenarioOptions({
        apps: [DEFAULT_APP],
        selected: DEFAULT_DEVELOPER_DIR,
        firstLaunch: { ok: false, stderr: 'license not accepted' }
      })
    )
    expect(result.state).toBe('xcode-first-launch-required')
  })

  it('reports a missing simulator runtime after simctl becomes usable', async () => {
    const result = await inspectIosSetup(
      scenarioOptions({
        apps: [DEFAULT_APP],
        selected: DEFAULT_DEVELOPER_DIR,
        devices: { ok: true, stdout: '{"devices":{}}' },
        runtimes: { ok: true, stdout: '{"runtimes":[]}' }
      })
    )
    expect(result.state).toBe('simulator-runtime-missing')
  })

  it('requires a compatible simulator device even when an iOS runtime exists', async () => {
    const result = await inspectIosSetup(
      scenarioOptions({
        apps: [DEFAULT_APP],
        selected: DEFAULT_DEVELOPER_DIR,
        devices: { ok: true, stdout: '{"devices":{}}' }
      })
    )
    expect(result.state).toBe('simulator-device-missing')
  })

  it('reports ready only after simctl lists a compatible iOS device', async () => {
    const result = await inspectIosSetup(
      scenarioOptions({ apps: [DEFAULT_APP], selected: DEFAULT_DEVELOPER_DIR })
    )
    expect(result.state).toBe('ready')
    expect(result.devices).toEqual([
      expect.objectContaining({ name: 'iPhone 16', runtime: expect.stringContaining('iOS-18-0') })
    ])
  })

  it('does not claim ready for an unavailable device returned by simctl', async () => {
    const result = await inspectIosSetup(
      scenarioOptions({
        apps: [DEFAULT_APP],
        selected: DEFAULT_DEVELOPER_DIR,
        devices: {
          ok: true,
          stdout: JSON.stringify({
            devices: {
              'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
                { name: 'iPhone 16', udid: 'device-1', isAvailable: false }
              ]
            }
          })
        }
      })
    )
    expect(result.state).toBe('simulator-device-missing')
  })

  it('reports malformed simctl output as an error instead of a missing runtime', async () => {
    const result = await inspectIosSetup(
      scenarioOptions({
        apps: [DEFAULT_APP],
        selected: DEFAULT_DEVELOPER_DIR,
        devices: { ok: true, stdout: 'not-json' }
      })
    )
    expect(result.state).toBe('error')
    expect(result.message).toMatch(/unreadable/)
  })

  it('reports a failed runtime query as an error instead of a missing runtime', async () => {
    const result = await inspectIosSetup(
      scenarioOptions({
        apps: [DEFAULT_APP],
        selected: DEFAULT_DEVELOPER_DIR,
        devices: { ok: true, stdout: '{"devices":{}}' },
        runtimes: { ok: false, stdout: '' }
      })
    )
    expect(result.state).toBe('error')
  })

  it('does not turn an unknown xcodebuild failure into a privileged setup action', async () => {
    const result = await inspectIosSetup(
      scenarioOptions({
        apps: [DEFAULT_APP],
        selected: DEFAULT_DEVELOPER_DIR,
        firstLaunch: { ok: false, stderr: 'xcodebuild crashed' }
      })
    )
    expect(result.state).toBe('error')
  })

  it('discovers Xcode installed at a non-default path through Spotlight', async () => {
    const appPath = '/Developer/Xcode-16.4.app'
    const result = await inspectIosSetup(scenarioOptions({ apps: [appPath], spotlight: [appPath] }))
    expect(result.recommendedXcode?.appPath).toBe(appPath)
    expect(result.state).toBe('xcode-selection-required')
  })

  it('re-probes stale selection state into ready after setup', async () => {
    const before = await inspectIosSetup(scenarioOptions({ apps: [DEFAULT_APP] }))
    const after = await inspectIosSetup(
      scenarioOptions({ apps: [DEFAULT_APP], selected: DEFAULT_DEVELOPER_DIR })
    )
    expect([before.state, after.state]).toEqual(['xcode-selection-required', 'ready'])
  })

  it.each(['linux', 'win32'] as const)('does not offer local iOS setup on %s', async (platform) => {
    const result = await inspectIosSetup(scenarioOptions({ platform, apps: [DEFAULT_APP] }))
    expect(result.state).toBe('unsupported')
    expect(result.recommendedXcode).toBeUndefined()
  })
})
