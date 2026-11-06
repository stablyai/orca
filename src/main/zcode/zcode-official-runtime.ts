import { existsSync as defaultExistsSync, realpathSync as defaultRealpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'

export type ZcodeOfficialRuntime = {
  electron: string
  bundle: string
  builtinProviderConfig?: string
}

export type ZcodeOfficialRuntimeDeps = {
  existsSync?: (path: string) => boolean
  realpathSync?: (path: string) => string
  platform?: NodeJS.Platform
  home?: string
  localAppData?: string
}

function platformPath(platform: NodeJS.Platform): typeof posix {
  return platform === 'win32' ? win32 : posix
}

function electronName(platform: NodeJS.Platform): string {
  switch (platform) {
    case 'darwin':
      return posix.join('Contents', 'MacOS', 'ZCode')
    case 'win32':
      return 'ZCode.exe'
    case 'aix':
    case 'android':
    case 'cygwin':
    case 'freebsd':
    case 'haiku':
    case 'linux':
    case 'netbsd':
    case 'openbsd':
    case 'sunos':
      return 'zcode'
  }
}

function runtimeBeside(
  existsSync: (path: string) => boolean,
  binary: string,
  platform: NodeJS.Platform
): ZcodeOfficialRuntime | null {
  const paths = platformPath(platform)
  const resourcesRoot =
    platform === 'darwin'
      ? paths.join(paths.dirname(paths.dirname(binary)), 'Resources')
      : paths.join(paths.dirname(binary), 'resources')
  const bundle = paths.join(resourcesRoot, 'glm', 'zcode.cjs')
  if (!existsSync(bundle)) {
    return null
  }
  const builtinProviderConfig = paths.join(
    resourcesRoot,
    'config',
    'provider',
    'zcode-builtin.json'
  )
  return {
    electron: binary,
    bundle,
    ...(existsSync(builtinProviderConfig) ? { builtinProviderConfig } : {})
  }
}

/** The official runtime a command names, or null for a standalone CLI. */
export function resolveZcodeOfficialRuntime(
  command: string,
  deps: ZcodeOfficialRuntimeDeps = {}
): ZcodeOfficialRuntime | null {
  const existsSync = deps.existsSync ?? defaultExistsSync
  const realpathSync = deps.realpathSync ?? defaultRealpathSync
  try {
    return runtimeBeside(existsSync, realpathSync(command), deps.platform ?? process.platform)
  } catch {
    return null
  }
}

function conventionalElectrons(deps: ZcodeOfficialRuntimeDeps): string[] {
  const platform = deps.platform ?? process.platform
  const paths = platformPath(platform)
  const home = deps.home ?? homedir()
  const localAppData =
    deps.localAppData ?? process.env.LOCALAPPDATA ?? paths.join(home, 'AppData', 'Local')
  const root = (segments: string[]): string => {
    const segmentsWithBinary = [...segments, electronName(platform)]
    return paths.join(...segmentsWithBinary)
  }
  switch (platform) {
    case 'darwin':
      return [root([home, 'Applications', 'ZCode.app']), root(['/Applications', 'ZCode.app'])]
    case 'win32':
      return [root([localAppData, 'Programs', 'ZCode'])]
    case 'aix':
    case 'android':
    case 'cygwin':
    case 'freebsd':
    case 'haiku':
    case 'linux':
    case 'netbsd':
    case 'openbsd':
    case 'sunos':
      return [root(['/opt/ZCode'])]
  }
}

/** The first official runtime among the candidates and platform install roots. */
export function probeZcodeOfficialRuntimes(
  candidates: readonly string[],
  deps: ZcodeOfficialRuntimeDeps = {}
): ZcodeOfficialRuntime | null {
  const existsSync = deps.existsSync ?? defaultExistsSync
  const platform = deps.platform ?? process.platform
  const lookBeside = (command: string): ZcodeOfficialRuntime | null => {
    if (!existsSync(command)) {
      return null
    }
    const beside = resolveZcodeOfficialRuntime(command, deps)
    if (beside) {
      return beside
    }
    const rootBinary = platformPath(platform).join(command, electronName(platform))
    return existsSync(rootBinary) ? runtimeBeside(existsSync, rootBinary, platform) : null
  }
  for (const command of [...candidates, ...conventionalElectrons(deps)]) {
    if (!command) {
      continue
    }
    const runtime = lookBeside(command)
    if (runtime) {
      return runtime
    }
  }
  return null
}
