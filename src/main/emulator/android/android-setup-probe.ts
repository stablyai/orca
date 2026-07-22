import { join } from 'node:path'
import type { AndroidSetupStatus } from '../../../shared/emulator-setup-types'

export type AndroidSetupProbeOptions = {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  homedir: string
  configuredPath?: string | null
  exists: (path: string) => boolean
  hasInstalledSystemImage: (path: string) => boolean
  backendAvailable: boolean
  backendMessage?: string
}

type Candidate = { path: string; configured: boolean }

function defaultSdkPath(options: AndroidSetupProbeOptions): string {
  if (options.platform === 'win32') {
    return join(
      options.env.LOCALAPPDATA ?? join(options.homedir, 'AppData', 'Local'),
      'Android',
      'Sdk'
    )
  }
  if (options.platform === 'darwin') {
    return join(options.homedir, 'Library', 'Android', 'sdk')
  }
  return join(options.homedir, 'Android', 'Sdk')
}

function sdkCandidates(options: AndroidSetupProbeOptions): Candidate[] {
  const candidates: Candidate[] = []
  const add = (path: string | null | undefined, configured: boolean): void => {
    const trimmed = path?.trim()
    if (trimmed && !candidates.some((candidate) => candidate.path === trimmed)) {
      candidates.push({ path: trimmed, configured })
    }
  }
  add(options.configuredPath, true)
  add(options.env.ANDROID_HOME, false)
  add(options.env.ANDROID_SDK_ROOT, false)
  add(defaultSdkPath(options), false)
  return candidates
}

function androidStudioCandidates(options: AndroidSetupProbeOptions): string[] {
  if (options.platform === 'darwin') {
    return [
      '/Applications/Android Studio.app',
      join(options.homedir, 'Applications', 'Android Studio.app')
    ]
  }
  if (options.platform === 'win32') {
    return [
      join(
        options.env.ProgramFiles ?? 'C:\\Program Files',
        'Android',
        'Android Studio',
        'bin',
        'studio64.exe'
      ),
      join(
        options.env.LOCALAPPDATA ?? join(options.homedir, 'AppData', 'Local'),
        'Programs',
        'Android Studio',
        'bin',
        'studio64.exe'
      )
    ]
  }
  return [
    '/opt/android-studio/bin/studio.sh',
    join(options.homedir, 'android-studio', 'bin', 'studio.sh')
  ]
}

export function inspectAndroidSetup(options: AndroidSetupProbeOptions): AndroidSetupStatus {
  const studioPath = androidStudioCandidates(options).find(options.exists)
  const candidates = sdkCandidates(options)
  const configured = candidates.find((candidate) => candidate.configured)
  const automatic = candidates.filter((candidate) => !candidate.configured)
  const executableSuffix = options.platform === 'win32' ? '.exe' : ''
  const hasCoreTools = (candidate: Candidate): boolean =>
    options.exists(join(candidate.path, 'platform-tools', `adb${executableSuffix}`)) &&
    options.exists(join(candidate.path, 'emulator', `emulator${executableSuffix}`))
  const selected =
    configured ??
    automatic.find((candidate) => options.exists(candidate.path) && hasCoreTools(candidate)) ??
    automatic.find((candidate) => options.exists(candidate.path))

  if (!selected || !options.exists(selected.path)) {
    return {
      state: configured ? 'sdk-invalid' : 'sdk-missing',
      message: configured
        ? 'The selected folder is not a complete Android SDK.'
        : studioPath
          ? 'Android Studio is installed, but its SDK has not been installed yet.'
          : 'Android Studio and the Android SDK were not found.',
      sdkPath: configured?.path,
      configuredPath: Boolean(configured),
      studioInstalled: Boolean(studioPath),
      studioPath,
      components: { platformTools: false, emulator: false, systemImages: false }
    }
  }

  const platformTools = options.exists(
    join(selected.path, 'platform-tools', `adb${executableSuffix}`)
  )
  const emulator = options.exists(join(selected.path, 'emulator', `emulator${executableSuffix}`))
  const systemImages = options.hasInstalledSystemImage(join(selected.path, 'system-images'))
  const base = {
    sdkPath: selected.path,
    configuredPath: selected.configured,
    studioInstalled: Boolean(studioPath),
    studioPath,
    components: { platformTools, emulator, systemImages }
  }

  if (!platformTools) {
    return {
      ...base,
      state: 'platform-tools-missing',
      message: 'Install Android SDK Platform-Tools in Android Studio.'
    }
  }
  if (!emulator) {
    return {
      ...base,
      state: 'emulator-missing',
      message: 'Install Android Emulator in Android Studio.'
    }
  }
  if (!systemImages) {
    return {
      ...base,
      state: 'system-image-missing',
      message: 'Install an Android system image in Android Studio, then create a virtual device.'
    }
  }
  if (!options.backendAvailable) {
    const deviceMissing = /no android devices|no avds found/i.test(options.backendMessage ?? '')
    return {
      ...base,
      state: deviceMissing || !options.backendMessage ? 'device-missing' : 'error',
      message: options.backendMessage || 'Create an Android Virtual Device in Android Studio.'
    }
  }
  return { ...base, state: 'ready', message: 'Ready' }
}
