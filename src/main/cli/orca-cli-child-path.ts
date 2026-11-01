// PTY and structured children must reach this app's CLI regardless of global registration.
import { delimiter, dirname, join } from 'node:path'
import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-environment'
import { readInheritedPath } from '../ipc/pty/host-env/path'
import { resolvePathEnvKey } from '../pty/windows-environment-path'
import { ensureLinuxTerminalOrcaCliShimDir } from './linux-terminal-orca-cli-shim'
import { getBundledLauncherPath } from './bundled-cli-launcher-path'
import { DEV_COMMAND_NAME } from './cli-install-constants'

export type OrcaCliChildPathOptions = {
  isPackaged: boolean
  userDataPath: string
  resourcesPath?: string | null
  /** Test seam — production reads the real platform, which is what every branch below assumes. */
  platform?: NodeJS.Platform
}

/** Return the launcher path so children can bypass login shells that reorder PATH; null if unavailable. */
export function prependOrcaCliDirToChildPath(
  env: Record<string, string>,
  opts: OrcaCliChildPathOptions
): string | null {
  const platform = opts.platform ?? process.platform
  delete env.ORCA_CLI_BIN_DIR
  // Honor injected Windows platforms when tests run on another host.
  const pathDelimiter = platform === 'win32' ? ';' : delimiter
  const hostLauncher = hasAppEnvironment() ? getAppEnvironment().getCliLauncherPath?.() : null
  if (hostLauncher) {
    const binDir = dirname(hostLauncher)
    const inheritedEntries = readInheritedPath(env, platform)
      .split(pathDelimiter)
      .filter((entry) => entry.length > 0 && entry !== binDir)
    env[resolvePathEnvKey(env, platform)] = [binDir, ...inheritedEntries].join(pathDelimiter)
    if (platform !== 'win32') {
      env.ORCA_CLI_BIN_DIR = binDir
    }
    env.ORCA_USER_DATA_PATH = opts.userDataPath
    env.ORCA_CLI_COMMAND = hostLauncher
    return hostLauncher
  }
  // Development children must reach their build rather than a globally installed release.
  if (!opts.isPackaged) {
    const devCliBin = join(opts.userDataPath, 'cli', 'bin')
    if (platform !== 'win32') {
      env.ORCA_CLI_BIN_DIR = devCliBin
    }
    const inheritedPath = readInheritedPath(env, platform)
    // Empty PATH segments can execute commands from cwd; avoid a trailing delimiter.
    env[resolvePathEnvKey(env, platform)] = inheritedPath
      ? `${devCliBin}${pathDelimiter}${inheritedPath}`
      : devCliBin
    return join(devCliBin, platform === 'win32' ? `${DEV_COMMAND_NAME}.cmd` : DEV_COMMAND_NAME)
  } else if (platform === 'linux') {
    // Managed children need bare `orca` to reach the CLI instead of GNOME's screen reader.
    const shimDir = ensureLinuxTerminalOrcaCliShimDir({ userDataPath: opts.userDataPath })
    if (shimDir) {
      env.ORCA_CLI_BIN_DIR = shimDir
      const inheritedEntries = readInheritedPath(env, platform)
        .split(pathDelimiter)
        .filter((entry) => entry.length > 0 && entry !== shimDir)
      env.PATH = [shimDir, ...inheritedEntries].join(pathDelimiter)
      const launcher = join(shimDir, 'orca')
      env.ORCA_CLI_COMMAND = launcher
      env.ORCA_USER_DATA_PATH = opts.userDataPath
      return launcher
    }
  } else if (opts.resourcesPath && (platform === 'darwin' || platform === 'win32')) {
    const bundledCliBin = join(opts.resourcesPath, 'bin')
    if (platform === 'darwin') {
      env.ORCA_CLI_BIN_DIR = bundledCliBin
    }
    const inheritedPath = readInheritedPath(env, platform)
    env[resolvePathEnvKey(env, platform)] = inheritedPath
      ? `${bundledCliBin}${pathDelimiter}${inheritedPath}`
      : bundledCliBin
    // Why the native launcher on Windows: `orca.cmd` refuses message bodies cmd.exe would mangle.
    return getBundledLauncherPath(platform, opts.resourcesPath)
  }
  return null
}
