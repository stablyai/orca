import { getDefaultWslDistro, parseWslPath, type WslPathInfo } from '../../wsl'
import {
  buildWslCapturedLoginShellCommand,
  buildWslExecArgs,
  buildWslLoginShellCommand,
  type WslCapturedLoginShellCommand
} from '../../../shared/wsl-login-shell-command'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import { UNTRANSLATED_GIT_OUTPUT_ENV } from '../../../shared/git-output-locale'
import type { WslGitReadEnvironment } from '../wsl-git-read-environment'
import {
  createWslProcessGroupTermination,
  type WslProcessGroupTermination
} from '../wsl-process-group-termination'
import { translateArgForWsl, translateArgsForWsl } from './wsl-path-translation'
import { resolveWslInteropSpawnCwd } from '../../wsl-interop-spawn-directory'

// Carry Git locale pins in the WSL command; these assignment values are shell-safe.
const GIT_OUTPUT_LOCALE_SHELL_PREFIX = Object.entries(UNTRANSLATED_GIT_OUTPUT_ENV)
  .map(([key, value]) => `${key}=${value}`)
  .join(' ')
const GIT_OUTPUT_LOCALE_ENV_ARGS = Object.entries(UNTRANSLATED_GIT_OUTPUT_ENV).map(
  ([key, value]) => `${key}=${value}`
)

// Override object-store values after login profiles run, appending profile alternates.
function wslGitObjectStorePrefix(env: NodeJS.ProcessEnv | undefined): string {
  const objectDirectory = env?.GIT_OBJECT_DIRECTORY
  const alternates = env?.GIT_ALTERNATE_OBJECT_DIRECTORIES
  // Forward only this quarantine's overrides, never inherited Windows-side paths.
  if (
    objectDirectory === undefined ||
    alternates === undefined ||
    objectDirectory === process.env.GIT_OBJECT_DIRECTORY
  ) {
    return ''
  }
  return (
    `GIT_OBJECT_DIRECTORY=${quotePosixShell(objectDirectory)} ` +
    `GIT_ALTERNATE_OBJECT_DIRECTORIES="\${GIT_ALTERNATE_OBJECT_DIRECTORIES:+$GIT_ALTERNATE_OBJECT_DIRECTORIES:}"${quotePosixShell(alternates)} `
  )
}

export type ResolvedCommand = {
  binary: string
  args: string[]
  cwd: string | undefined
  wsl: WslPathInfo | null
  wslMode: 'direct-git' | 'login-shell' | 'non-login-shell' | null
  /** Present only when the caller opted into a fenced login-shell read. */
  captured?: WslCapturedLoginShellCommand
  termination?: WslProcessGroupTermination
}

let defaultWslDistroOverride: string | null = null

export function setDefaultWslDistroOverride(distro: string | null): void {
  defaultWslDistroOverride = distro
}

export function resolveDefaultWslCli(
  command: 'gh' | 'glab',
  args: string[]
): ResolvedCommand | null {
  const distro = defaultWslDistroOverride ?? getDefaultWslDistro()
  return distro ? resolveCommand(command, args, undefined, distro) : null
}

/** Use shell cd for WSL cwd: wsl.exe --cd can fail with ERROR_PATH_NOT_FOUND under Node spawning. */
export function resolveCommand(
  command: string,
  args: string[],
  cwd: string | undefined,
  wslDistroOverride?: string,
  options: {
    useWslLoginShell?: boolean
    captureLoginShellOutput?: boolean
    wslGitReadEnvironment?: WslGitReadEnvironment
    env?: NodeJS.ProcessEnv
    terminationBarrier?: boolean
    /** Pre-quoted shell expression that names the program inside WSL, replacing `command`. */
    wslShellCommand?: string
    /** Distinguish failed cd from rg's no-match exit 1. */
    cwdFailureExitCode?: number
  } = {}
): ResolvedCommand {
  if (process.platform !== 'win32') {
    return { binary: command, args, cwd, wsl: null, wslMode: null }
  }

  // Distro hints route global CLI calls that have no cwd to identify a WSL guest.
  const cwdWsl = cwd ? parseWslPath(cwd) : null
  const wsl: WslPathInfo | null =
    cwdWsl ?? (wslDistroOverride ? { distro: wslDistroOverride, linuxPath: '' } : null)
  if (!wsl) {
    return { binary: command, args, cwd, wsl: null, wslMode: null }
  }

  const translatedArgs = translateArgsForWsl(args)
  // WSL does not inherit unlisted Windows env vars; carry locale pins in the command.
  const localePrefix =
    command === 'git'
      ? `${GIT_OUTPUT_LOCALE_SHELL_PREFIX} ${wslGitObjectStorePrefix(options.env)}`
      : ''
  const escapedCommand = options.wslShellCommand ?? quotePosixShell(command)
  // Quote each argument against shell splitting and expansion.
  const escapedArgs = translatedArgs.map(quotePosixShell)
  const linuxCwd = cwdWsl?.linuxPath ?? (cwd && wslDistroOverride ? translateArgForWsl(cwd) : null)
  const invocation = `${localePrefix}${escapedCommand} ${escapedArgs.join(' ')}`
  const enterCwd = linuxCwd
    ? options.cwdFailureExitCode === undefined
      ? `cd ${quotePosixShell(linuxCwd)} && `
      : `cd ${quotePosixShell(linuxCwd)} || exit ${Math.trunc(options.cwdFailureExitCode)}; `
    : ''
  const shellCmd = `${enterCwd}${invocation}`

  if (command === 'git' && options.wslGitReadEnvironment) {
    const optionalLocks = options.env?.GIT_OPTIONAL_LOCKS
    return withWslProcessGroupTermination(
      {
        binary: 'wsl.exe',
        args: [
          '-d',
          wsl.distro,
          '--exec',
          '/usr/bin/env',
          `PATH=${options.wslGitReadEnvironment.path}`,
          `HOME=${options.wslGitReadEnvironment.home}`,
          ...GIT_OUTPUT_LOCALE_ENV_ARGS,
          ...(optionalLocks !== undefined ? [`GIT_OPTIONAL_LOCKS=${optionalLocks}`] : []),
          options.wslGitReadEnvironment.gitPath,
          ...(linuxCwd ? ['-C', linuxCwd] : []),
          ...translatedArgs
        ],
        cwd: resolveWslInteropSpawnCwd(),
        wsl,
        wslMode: 'direct-git'
      },
      options.terminationBarrier
    )
  }

  if (options.useWslLoginShell) {
    // Fence only buffered reads: login rc output contaminates stdout, but markers would corrupt streaming records.
    if (options.captureLoginShellOutput) {
      const captured = buildWslCapturedLoginShellCommand(shellCmd)
      return withWslProcessGroupTermination(
        {
          binary: 'wsl.exe',
          args: buildWslExecArgs(wsl.distro, ['sh', '-lc', captured.command]),
          cwd: resolveWslInteropSpawnCwd(),
          wsl,
          wslMode: 'login-shell',
          captured
        },
        options.terminationBarrier
      )
    }
    return withWslProcessGroupTermination(
      {
        binary: 'wsl.exe',
        args: buildWslExecArgs(wsl.distro, ['sh', '-lc', buildWslLoginShellCommand(shellCmd)]),
        cwd: resolveWslInteropSpawnCwd(),
        wsl,
        wslMode: 'login-shell'
      },
      options.terminationBarrier
    )
  }

  return withWslProcessGroupTermination(
    {
      binary: 'wsl.exe',
      args: buildWslExecArgs(wsl.distro, ['bash', '-c', shellCmd]),
      // Use a stable Win32 spawn cwd; inheriting Orca's deletable UNC cwd can break CreateProcessW.
      cwd: resolveWslInteropSpawnCwd(),
      wsl,
      wslMode: 'non-login-shell'
    },
    options.terminationBarrier
  )
}

function withWslProcessGroupTermination(
  command: ResolvedCommand,
  enabled: boolean | undefined
): ResolvedCommand {
  if (!enabled || !command.wsl) {
    return command
  }
  const execIndex = command.args.indexOf('--exec')
  if (execIndex === -1) {
    return command
  }
  const termination = createWslProcessGroupTermination(command.wsl.distro)
  return {
    ...command,
    args: [
      ...command.args.slice(0, execIndex + 1),
      ...termination.wrapGuestArgs(command.args.slice(execIndex + 1))
    ],
    termination
  }
}
