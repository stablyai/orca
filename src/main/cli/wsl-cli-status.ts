import type { CliInstallStatus } from '../../shared/cli-install-types'
import { getBridgePathFromCommandPath, getPosixDirname, quoteShell } from './wsl-cli-scripts'

const WSL_COMMAND_NAME = 'orca-ide'

export type ReadyWslCliState = {
  distro: string
  commandPath: string
  bridgePath: string
  launcherPath: string
  pathConfigured: boolean
}

export async function readWslCliCommandFile(
  run: (distro: string, command: string) => Promise<string>,
  distro: string,
  commandPath: string
): Promise<(string & {}) | 'not_file' | null> {
  const output = await run(
    distro,
    [
      `if [ -L ${quoteShell(commandPath)} ]; then`,
      '  printf __ORCA_NOT_FILE__',
      `elif [ ! -e ${quoteShell(commandPath)} ]; then`,
      '  printf __ORCA_MISSING__',
      `elif [ ! -f ${quoteShell(commandPath)} ]; then`,
      '  printf __ORCA_NOT_FILE__',
      'else',
      `  cat ${quoteShell(commandPath)}`,
      'fi'
    ].join('\n')
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
  pathConfigured: boolean
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
      args.state === 'installed' && !args.pathConfigured
        ? `${args.commandPath} is registered, but ${getPosixDirname(args.commandPath)} is not on PATH in ${args.distro}.`
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

export async function resolveReadyWslCliState(args: {
  platform: NodeJS.Platform
  distro: string | null
  getHostStatus: () => Promise<CliInstallStatus>
  run: (distro: string, command: string) => Promise<string>
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

  const home = (await args.run(args.distro, 'printf %s "$HOME"')).trim()
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
        '{ command -v powershell.exe >/dev/null 2>&1 || [ -x /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe ]; } && command -v wslpath >/dev/null 2>&1 && printf yes || printf no'
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
  const pathConfigured =
    (
      await args.run(
        args.distro,
        `case ":$PATH:" in *:${quoteShell(pathDirectory)}:*) printf yes ;; *) printf no ;; esac`
      )
    ).trim() === 'yes'

  return {
    distro: args.distro,
    commandPath,
    bridgePath: getBridgePathFromCommandPath(commandPath),
    launcherPath: hostStatus.launcherPath,
    pathConfigured
  }
}
