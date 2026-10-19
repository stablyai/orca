import type { CliInstallStatus } from '../../shared/cli-install-types'
import { getBridgePathFromCommandPath, getPosixDirname } from './wsl-cli-scripts'
import { quotePosixShellDoubleQuotedApostrophe } from '../../shared/shell-argument-quoting'

const WSL_COMMAND_NAME = 'orca-ide'

export type WslCliRunOptions = {
  /** Only the `$PATH` check needs it; everything else reads $HOME or absolute paths. */
  loginPath?: 'none' | 'preferred'
}

export type WslCliRun = (
  distro: string,
  command: string,
  options?: WslCliRunOptions
) => Promise<string>

/** wsl.exe did not answer in time: usually a distro still booting, so retryable, never a verdict. */
export class WslCliUnreachableError extends Error {
  constructor(readonly distro: string) {
    super(`WSL (${distro}) did not respond in time. It may still be starting; try again.`)
    this.name = 'WslCliUnreachableError'
  }
}

/** The login-shell PATH probe failed, so whether ~/.local/bin is on PATH is unknown. */
export class WslCliLoginPathUnavailableError extends Error {
  constructor(readonly distro: string) {
    super('Could not reach the WSL distro. Try again.')
    this.name = 'WslCliLoginPathUnavailableError'
  }
}

export type ReadyWslCliState = {
  distro: string
  commandPath: string
  bridgePath: string
  launcherPath: string
  /** Null when the login PATH could not be resolved (e.g. a blocking ~/.profile). */
  pathConfigured: boolean | null
}

export async function readWslCliCommandFile(
  run: WslCliRun,
  distro: string,
  commandPath: string
): Promise<(string & {}) | 'not_file' | null> {
  const output = await run(
    distro,
    [
      `if [ -L ${quotePosixShellDoubleQuotedApostrophe(commandPath)} ]; then`,
      '  printf __ORCA_NOT_FILE__',
      `elif [ ! -e ${quotePosixShellDoubleQuotedApostrophe(commandPath)} ]; then`,
      '  printf __ORCA_MISSING__',
      `elif [ ! -f ${quotePosixShellDoubleQuotedApostrophe(commandPath)} ]; then`,
      '  printf __ORCA_NOT_FILE__',
      'else',
      `  cat ${quotePosixShellDoubleQuotedApostrophe(commandPath)}`,
      'fi'
    ].join('\n'),
    { loginPath: 'none' }
  )
  if (output === '__ORCA_MISSING__') {
    return null
  }
  if (output === '__ORCA_NOT_FILE__') {
    return 'not_file'
  }
  return output
}

export function buildWslCliStatus(args: {
  distro: string
  commandPath: string
  launcherPath: string
  state: CliInstallStatus['state']
  currentTarget: string | null
  pathConfigured: boolean | null
  detail: string
}): CliInstallStatus {
  return {
    platform: 'linux',
    commandName: WSL_COMMAND_NAME,
    commandPath: args.commandPath,
    pathDirectory: getPosixDirname(args.commandPath),
    pathConfigured: args.pathConfigured,
    launcherPath: args.launcherPath,
    installMethod: 'wrapper',
    supported: true,
    state: args.state,
    currentTarget: args.currentTarget,
    unsupportedReason: null,
    detail:
      args.state === 'installed' && args.pathConfigured === false
        ? `${args.commandPath} is registered, but ${getPosixDirname(args.commandPath)} is not on PATH in ${args.distro}.`
        : args.state === 'installed' && args.pathConfigured === null
          ? `${args.commandPath} is registered, but WSL's login PATH could not be read in ${args.distro}.`
          : args.detail
  }
}

export function unsupportedWslCliStatus(
  unsupportedReason: NonNullable<CliInstallStatus['unsupportedReason']>,
  detail: string
): CliInstallStatus {
  return {
    platform: 'linux',
    commandName: WSL_COMMAND_NAME,
    commandPath: null,
    pathDirectory: null,
    pathConfigured: false,
    launcherPath: null,
    installMethod: null,
    supported: false,
    state: 'unsupported',
    currentTarget: null,
    unsupportedReason,
    detail
  }
}

/** Settings shows this instead of a raw IPC timeout; the row stays refreshable. */
export function unreachableWslCliStatus(distro: string): CliInstallStatus {
  return unsupportedWslCliStatus(
    'wsl_unreachable',
    `WSL (${distro}) did not respond in time. It may still be starting; refresh to try again.`
  )
}

export async function resolveReadyWslCliState(args: {
  platform: NodeJS.Platform
  distro: string | null
  getHostStatus: () => Promise<CliInstallStatus>
  run: WslCliRun
}): Promise<{ status: CliInstallStatus } | ReadyWslCliState> {
  if (args.platform !== 'win32') {
    return {
      status: unsupportedWslCliStatus(
        'platform_not_supported',
        'WSL CLI registration is only available on Windows.'
      )
    }
  }
  if (!args.distro) {
    return {
      status: unsupportedWslCliStatus('platform_not_supported', 'No WSL distribution is available.')
    }
  }

  const hostStatus = await args.getHostStatus()
  if (!hostStatus.launcherPath) {
    return {
      status: unsupportedWslCliStatus(
        hostStatus.unsupportedReason ?? 'launcher_missing',
        hostStatus.detail ?? 'The Windows Orca CLI launcher is missing.'
      )
    }
  }

  // Why 'none': this first call is the one that boots a stopped distro, and a
  // login-PATH probe would take half its budget (#29497).
  const home = (await args.run(args.distro, 'printf %s "$HOME"', { loginPath: 'none' })).trim()
  if (!home.startsWith('/')) {
    return {
      status: unsupportedWslCliStatus(
        'launcher_missing',
        'Unable to resolve the WSL home directory.'
      )
    }
  }

  const interopReady =
    (
      await args.run(
        args.distro,
        '{ command -v powershell.exe >/dev/null 2>&1 || [ -x /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe ]; } && command -v wslpath >/dev/null 2>&1 && printf yes || printf no',
        // WSL appends the Windows PATH and ships wslpath in /usr/bin, so the
        // default PATH answers this; the absolute fallback covers the rest.
        { loginPath: 'none' }
      )
    ).trim() === 'yes'
  if (!interopReady) {
    return {
      status: unsupportedWslCliStatus(
        'launcher_missing',
        'WSL Windows interop is unavailable; Orca cannot launch the Windows CLI from WSL.'
      )
    }
  }

  const pathDirectory = `${home}/.local/bin`
  const commandPath = `${pathDirectory}/${WSL_COMMAND_NAME}`
  const pathConfigured = await readPathConfigured(args.run, args.distro, pathDirectory)

  return {
    distro: args.distro,
    commandPath,
    bridgePath: getBridgePathFromCommandPath(commandPath),
    launcherPath: hostStatus.launcherPath,
    pathConfigured
  }
}

async function readPathConfigured(
  run: WslCliRun,
  distro: string,
  pathDirectory: string
): Promise<boolean | null> {
  try {
    const output = await run(
      distro,
      `case ":$PATH:" in *:${quotePosixShellDoubleQuotedApostrophe(pathDirectory)}:*) printf yes ;; *) printf no ;; esac`,
      { loginPath: 'preferred' }
    )
    return output.trim() === 'yes'
  } catch (error) {
    // Why null, not throw: the distro already answered the calls before this,
    // so a blocking ~/.profile (#14288) must not hide whether the command file
    // exists; null is "unknown", never "not on PATH".
    if (
      error instanceof WslCliLoginPathUnavailableError ||
      error instanceof WslCliUnreachableError
    ) {
      return null
    }
    throw error
  }
}
