import { join } from 'node:path'

export type HarmonySdkPaths = {
  sdkRoot: string
  hdc: string
  emulator: string
}

export type DiscoverHarmonySdkOptions = {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  homedir: string
  exists: (path: string) => boolean
}

// Pure/dependency-injected: env, platform, homedir and fs probes are parameters
// so the resolver is unit-testable; the host module wires the real I/O.
export function discoverHarmonySdk(options: DiscoverHarmonySdkOptions): HarmonySdkPaths | null {
  const { env, platform, homedir, exists } = options
  const win32 = platform === 'win32'

  for (const sdkRoot of candidateSdkRoots(env, platform, homedir)) {
    for (const tools of toolPathPairs(sdkRoot, win32)) {
      // Require both tools: hdc (targets/input/snapshots) and the Emulator
      // binary (boot/list/stop instances). A partial toolchain isn't usable.
      if (exists(tools.hdc) && exists(tools.emulator)) {
        return { sdkRoot, ...tools }
      }
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
  for (const name of ['HOS_SDK_HOME', 'DEVECO_SDK_HOME', 'OHOS_SDK_HOME'] as const) {
    const value = env[name]
    if (value) {
      roots.push(...withAppContents(value))
    }
  }
  roots.push(...defaultSdkRoots(env, platform, homedir))
  return roots
}

// A picked path may be DevEco-Studio.app itself rather than its Contents dir.
function withAppContents(root: string): string[] {
  return root.endsWith('.app') ? [join(root, 'Contents'), root] : [root]
}

function defaultSdkRoots(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  homedir: string
): string[] {
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA ?? join(homedir, 'AppData', 'Local')
    const programFiles = env.PROGRAMFILES ?? join(homedir, 'AppData', 'Local', 'Programs')
    return [join(localAppData, 'Huawei', 'Sdk'), join(programFiles, 'Huawei', 'DevEco Studio')]
  }
  if (platform === 'darwin') {
    return [
      '/Applications/DevEco-Studio.app/Contents',
      join(homedir, 'Library', 'Huawei', 'Sdk'),
      join(homedir, 'Huawei', 'Sdk')
    ]
  }
  return [join(homedir, 'command-line-tools'), join(homedir, 'Huawei', 'Sdk')]
}

// Possible hdc/Emulator layouts inside a toolchain root (DevEco install dir,
// its macOS Contents dir, command-line-tools, or an SDK root).
function toolPathPairs(sdkRoot: string, win32: boolean): { hdc: string; emulator: string }[] {
  const hdcName = win32 ? 'hdc.exe' : 'hdc'
  const emulatorName = win32 ? 'Emulator.exe' : 'Emulator'
  const bundledHdc = join(sdkRoot, 'sdk', 'default', 'openharmony', 'toolchains', hdcName)
  const devEcoEmulator = join(sdkRoot, 'tools', 'emulator', emulatorName)
  const looseEmulator = join(sdkRoot, 'emulator', emulatorName)
  return [
    { hdc: bundledHdc, emulator: devEcoEmulator },
    { hdc: bundledHdc, emulator: looseEmulator },
    { hdc: join(sdkRoot, 'toolchains', hdcName), emulator: looseEmulator },
    { hdc: join(sdkRoot, 'bin', hdcName), emulator: looseEmulator },
    { hdc: join(sdkRoot, 'default', 'openharmony', 'toolchains', hdcName), emulator: looseEmulator }
  ]
}
