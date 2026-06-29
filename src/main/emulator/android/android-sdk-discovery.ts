import { join } from 'node:path'

export type AndroidSdkPaths = {
  sdkRoot: string
  adb: string
  emulator: string
  avdmanager: string
}

export type DiscoverAndroidSdkOptions = {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  homedir: string
  exists: (path: string) => boolean
}

// Pure/dependency-injected: every external input (env, platform, homedir, fs probe)
// is a parameter so the resolver is unit-testable; Phase B wires the real I/O.
export function discoverAndroidSdk(options: DiscoverAndroidSdkOptions): AndroidSdkPaths | null {
  const { env, platform, homedir, exists } = options
  const win32 = platform === 'win32'

  for (const sdkRoot of candidateSdkRoots(env, platform, homedir)) {
    const paths = resolveToolPaths(sdkRoot, win32)
    // Require both tools the backend depends on: adb (devices/input/stream) and
    // the emulator binary (boot + list AVDs). A partial SDK isn't usable.
    if (exists(paths.adb) && exists(paths.emulator)) {
      return paths
    }
  }

  return null
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
    emulator: join(sdkRoot, 'emulator', win32 ? 'emulator.exe' : 'emulator'),
    avdmanager: join(
      sdkRoot,
      'cmdline-tools',
      'latest',
      'bin',
      win32 ? 'avdmanager.bat' : 'avdmanager'
    )
  }
}
