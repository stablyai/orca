import { access, realpath as defaultRealpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'

export type ZcodeOfficialRuntime = {
  electron: string
  bundle: string
  builtinProviderConfig?: string
}

export type ZcodeOfficialRuntimeDeps = {
  exists?: (path: string) => Promise<boolean>
  realpath?: (path: string) => Promise<string>
  platform?: NodeJS.Platform
  home?: string
  localAppData?: string
}

const defaultExists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false
  )

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

async function runtimeBeside(
  exists: (path: string) => Promise<boolean>,
  binary: string,
  platform: NodeJS.Platform
): Promise<ZcodeOfficialRuntime | null> {
  const paths = platformPath(platform)
  const resourcesRoot =
    platform === 'darwin'
      ? paths.join(paths.dirname(paths.dirname(binary)), 'Resources')
      : paths.join(paths.dirname(binary), 'resources')
  const bundle = paths.join(resourcesRoot, 'glm', 'zcode.cjs')
  if (!(await exists(bundle))) {
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
    ...((await exists(builtinProviderConfig)) ? { builtinProviderConfig } : {})
  }
}

/** The official runtime a command names, or null for a standalone CLI. */
export async function resolveZcodeOfficialRuntime(
  command: string,
  deps: ZcodeOfficialRuntimeDeps = {}
): Promise<ZcodeOfficialRuntime | null> {
  const exists = deps.exists ?? defaultExists
  const realpath = deps.realpath ?? defaultRealpath
  try {
    return await runtimeBeside(exists, await realpath(command), deps.platform ?? process.platform)
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
export async function probeZcodeOfficialRuntimes(
  candidates: readonly string[],
  deps: ZcodeOfficialRuntimeDeps = {}
): Promise<ZcodeOfficialRuntime | null> {
  const exists = deps.exists ?? defaultExists
  const platform = deps.platform ?? process.platform
  const lookBeside = async (command: string): Promise<ZcodeOfficialRuntime | null> => {
    if (!(await exists(command))) {
      return null
    }
    const beside = await resolveZcodeOfficialRuntime(command, deps)
    if (beside) {
      return beside
    }
    const rootBinary = platformPath(platform).join(command, electronName(platform))
    return (await exists(rootBinary)) ? runtimeBeside(exists, rootBinary, platform) : null
  }
  for (const command of [...candidates, ...conventionalElectrons(deps)]) {
    if (!command) {
      continue
    }
    const runtime = await lookBeside(command)
    if (runtime) {
      return runtime
    }
  }
  return null
}
