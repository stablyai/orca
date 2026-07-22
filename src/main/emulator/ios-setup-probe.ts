import { basename, dirname, join } from 'node:path'
import type { IosSetupStatus, XcodeApplication } from '../../shared/emulator-setup-types'

type CommandResult = { ok: boolean; stdout: string; stderr: string }

export type IosSetupProbeOptions = {
  platform: NodeJS.Platform
  homedir: string
  exists: (path: string) => boolean
  listDirectory: (path: string) => string[]
  run: (file: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<CommandResult>
}

function xcodeFromDeveloperDir(developerDir: string): XcodeApplication | null {
  if (!developerDir.endsWith('.app/Contents/Developer')) {
    return null
  }
  const appPath = dirname(dirname(developerDir))
  return { appPath, developerDir, name: basename(appPath, '.app') }
}

function addXcode(
  applications: Map<string, XcodeApplication>,
  appPath: string,
  exists: (path: string) => boolean
): void {
  const developerDir = join(appPath, 'Contents', 'Developer')
  if (!appPath.endsWith('.app') || !exists(join(developerDir, 'usr', 'bin', 'xcodebuild'))) {
    return
  }
  applications.set(appPath, { appPath, developerDir, name: basename(appPath, '.app') })
}

async function discoverXcodes(
  options: IosSetupProbeOptions,
  selectedDeveloperDir?: string
): Promise<XcodeApplication[]> {
  const applications = new Map<string, XcodeApplication>()
  for (const root of ['/Applications', join(options.homedir, 'Applications')]) {
    for (const name of options.listDirectory(root)) {
      if (/^Xcode.*\.app$/i.test(name)) {
        addXcode(applications, join(root, name), options.exists)
      }
    }
  }
  if (selectedDeveloperDir) {
    const selected = xcodeFromDeveloperDir(selectedDeveloperDir)
    if (selected) {
      addXcode(applications, selected.appPath, options.exists)
    }
  }
  const spotlight = await options.run('/usr/bin/mdfind', [
    "kMDItemCFBundleIdentifier == 'com.apple.dt.Xcode'"
  ])
  if (spotlight.ok) {
    for (const appPath of spotlight.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)) {
      addXcode(applications, appPath, options.exists)
    }
  }
  return [...applications.values()].sort((left, right) => {
    if (left.appPath === '/Applications/Xcode.app') {
      return -1
    }
    if (right.appPath === '/Applications/Xcode.app') {
      return 1
    }
    return left.name.localeCompare(right.name)
  })
}

function commandMessage(result: CommandResult): string {
  return `${result.stderr}\n${result.stdout}`.trim()
}

function hasPendingXcodeSetup(result: CommandResult): boolean {
  const detail = commandMessage(result).toLowerCase()
  return (
    detail.includes('license') ||
    detail.includes('first launch') ||
    detail.includes('runfirstlaunch') ||
    detail.includes('additional components')
  )
}

function parseIosDevices(stdout: string): IosSetupStatus['devices'] | null {
  try {
    const groups = (
      JSON.parse(stdout || '{}') as {
        devices?: Record<
          string,
          { name?: string; udid?: string; state?: string; isAvailable?: boolean }[]
        >
      }
    ).devices
    return Object.entries(groups ?? {}).flatMap(([runtime, rows]) =>
      runtime.includes('SimRuntime.iOS-')
        ? rows.flatMap((device) =>
            device.udid && device.isAvailable !== false
              ? [
                  {
                    name: device.name ?? device.udid,
                    udid: device.udid,
                    state: device.state ?? 'Unknown',
                    runtime,
                    isAvailable: device.isAvailable
                  }
                ]
              : []
          )
        : []
    )
  } catch {
    return null
  }
}

function hasIosRuntime(stdout: string): boolean | null {
  try {
    const runtimes = (
      JSON.parse(stdout || '{}') as {
        runtimes?: { identifier?: string; isAvailable?: boolean }[]
      }
    ).runtimes
    return Boolean(
      runtimes?.some(
        (runtime) =>
          runtime.identifier?.includes('SimRuntime.iOS-') && runtime.isAvailable !== false
      )
    )
  } catch {
    return null
  }
}

export async function inspectIosSetup(options: IosSetupProbeOptions): Promise<IosSetupStatus> {
  if (options.platform !== 'darwin') {
    return {
      state: 'unsupported',
      message: 'iOS Simulator is available only on a local Mac.',
      installedXcodes: [],
      devices: []
    }
  }
  const selection = await options.run('/usr/bin/xcode-select', ['-p'])
  const selectedDeveloperDir = selection.ok ? selection.stdout.trim() : undefined
  const installedXcodes = await discoverXcodes(options, selectedDeveloperDir)
  const recommendedXcode = installedXcodes[0]
  if (!recommendedXcode) {
    return {
      state: 'xcode-missing',
      message: 'Full Xcode is not installed.',
      selectedDeveloperDir,
      installedXcodes,
      devices: []
    }
  }
  const selectedXcode = installedXcodes.find((xcode) => xcode.developerDir === selectedDeveloperDir)
  if (!selectedXcode) {
    return {
      state: 'xcode-selection-required',
      message: `${recommendedXcode.name} is installed, but macOS is still using the smaller Command Line Tools package. Use Installed Xcode will ask for administrator approval before changing it.`,
      selectedDeveloperDir,
      recommendedXcode,
      installedXcodes,
      devices: []
    }
  }

  const env = { ...process.env, DEVELOPER_DIR: selectedXcode.developerDir }
  const firstLaunch = await options.run(
    join(selectedXcode.developerDir, 'usr', 'bin', 'xcodebuild'),
    ['-checkFirstLaunchStatus'],
    env
  )
  if (!firstLaunch.ok) {
    const pendingSetup = hasPendingXcodeSetup(firstLaunch)
    return {
      state: pendingSetup ? 'xcode-first-launch-required' : 'error',
      message: pendingSetup
        ? 'Xcode needs its license accepted and required components installed. Finish Xcode Setup will ask for administrator approval.'
        : 'Xcode could not check its setup status. Open Xcode, resolve any setup message, then refresh.',
      selectedDeveloperDir,
      recommendedXcode: selectedXcode,
      installedXcodes,
      devices: []
    }
  }
  const devices = await options.run(
    '/usr/bin/xcrun',
    ['simctl', 'list', 'devices', 'available', '-j'],
    env
  )
  if (!devices.ok) {
    return {
      state: hasPendingXcodeSetup(devices) ? 'xcode-first-launch-required' : 'error',
      message: hasPendingXcodeSetup(devices)
        ? 'Xcode needs its license accepted and required components installed. Finish Xcode Setup will ask for administrator approval.'
        : 'Xcode could not list Simulator devices. Open Xcode, resolve any setup message, then refresh.',
      selectedDeveloperDir,
      recommendedXcode: selectedXcode,
      installedXcodes,
      devices: []
    }
  }
  const parsedDevices = parseIosDevices(devices.stdout)
  if (!parsedDevices) {
    return {
      state: 'error',
      message: 'Xcode returned an unreadable Simulator device list. Open Xcode, then refresh.',
      selectedDeveloperDir,
      recommendedXcode: selectedXcode,
      installedXcodes,
      devices: []
    }
  }
  if (parsedDevices.length > 0) {
    return {
      state: 'ready',
      message: 'Ready',
      selectedDeveloperDir,
      recommendedXcode: selectedXcode,
      installedXcodes,
      devices: parsedDevices
    }
  }
  const runtimes = await options.run(
    '/usr/bin/xcrun',
    ['simctl', 'list', 'runtimes', 'available', '-j'],
    env
  )
  const runtimeAvailable = runtimes.ok ? hasIosRuntime(runtimes.stdout) : null
  if (runtimeAvailable === null) {
    return {
      state: 'error',
      message: 'Xcode could not read installed Simulator runtimes. Open Xcode, then refresh.',
      selectedDeveloperDir,
      recommendedXcode: selectedXcode,
      installedXcodes,
      devices: []
    }
  }
  const state = runtimeAvailable ? 'simulator-device-missing' : 'simulator-runtime-missing'
  return {
    state,
    message:
      state === 'simulator-device-missing'
        ? 'An iOS runtime is installed, but no compatible device exists. Create one in Xcode > Window > Devices and Simulators.'
        : 'No compatible iOS Simulator runtime is installed. Install one in Xcode > Settings > Components (Platforms on older Xcode versions).',
    selectedDeveloperDir,
    recommendedXcode: selectedXcode,
    installedXcodes,
    devices: []
  }
}
