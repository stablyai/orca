import { join } from 'node:path'

export type AndroidSdkPaths = {
  /** Null when only a standalone adb (e.g. distro android-tools) was found. */
  sdkRoot: string | null
  adb: string
  /** Null without the SDK emulator package: physical devices work, AVDs are unavailable. */
  emulator: string | null
}

export type DiscoverAndroidSdkOptions = {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  homedir: string
  exists: (path: string) => boolean
  findAdbOnPath: () => string | null
}

export function discoverAndroidSdk(options: DiscoverAndroidSdkOptions): AndroidSdkPaths | null {
  const { env, platform, homedir, exists } = options
  const win32 = platform === 'win32'

  const rootsWithAdb = candidateSdkRoots(env, platform, homedir)
    .map((sdkRoot) => resolveToolPaths(sdkRoot, win32))
    .filter((paths) => exists(paths.adb))
  // Prefer a full SDK so AVDs stay available when an adb-only root comes first.
  const full = rootsWithAdb.find((paths) => paths.emulator && exists(paths.emulator))
  if (full) {
    return full
  }
  if (rootsWithAdb[0]) {
    return { ...rootsWithAdb[0], emulator: null }
  }
  const adb = options.findAdbOnPath()
  return adb ? { sdkRoot: null, adb, emulator: null } : null
}

function candidateSdkRoots(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  homedir: string
): string[] {
  const roots: string[] = []
  if (env.ANDROID_HOME) {
    roots.push(env.ANDROID_HOME)
  }
  if (env.ANDROID_SDK_ROOT) {
    roots.push(env.ANDROID_SDK_ROOT)
  }
  roots.push(defaultSdkRoot(env, platform, homedir))
  return roots
}

function defaultSdkRoot(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  homedir: string
): string {
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA ?? join(homedir, 'AppData', 'Local')
    return join(localAppData, 'Android', 'Sdk')
  }
  if (platform === 'darwin') {
    return join(homedir, 'Library', 'Android', 'sdk')
  }
  return join(homedir, 'Android', 'Sdk')
}

function resolveToolPaths(sdkRoot: string, win32: boolean): AndroidSdkPaths {
  return {
    sdkRoot,
    adb: join(sdkRoot, 'platform-tools', win32 ? 'adb.exe' : 'adb'),
    emulator: join(sdkRoot, 'emulator', win32 ? 'emulator.exe' : 'emulator')
  }
}
