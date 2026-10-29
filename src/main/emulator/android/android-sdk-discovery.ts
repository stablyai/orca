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

export function discoverAndroidSdk(options: DiscoverAndroidSdkOptions): AndroidSdkPaths | null {
  const { env, platform, homedir, exists } = options
  const win32 = platform === 'win32'

  for (const sdkRoot of candidateSdkRoots(env, platform, homedir)) {
    const paths = resolveToolPaths(sdkRoot, win32)
    // Both adb and the emulator binary are required for backend operations.
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
