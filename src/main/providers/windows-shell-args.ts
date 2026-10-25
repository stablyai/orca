import { win32 as pathWin32 } from 'node:path'
import { isWindowsGitBashShellPath } from '../git-bash'
import { parseWslPath, toLinuxPath, toWindowsWslPath } from '../wsl'
import {
  buildWslExecArgs,
  buildWslInteractiveLoginShellCommand
} from '../../shared/wsl-login-shell-command'
import { quotePosixShell } from '../../shared/shell-argument-quoting'
import { getBashWrapperLaunchArgs } from './local-pty-shell-ready'
import { ensureShellReadyWrappersAt } from './local-pty-shell-ready-wrapper-generation'
import {
  encodePowerShellCommand,
  getPowerShellOsc133Bootstrap
} from '../powershell-osc133-bootstrap'
import { quoteStartupArg } from '../../shared/tui-agent-startup-shell'

/** cmd.exe's own documented ceiling; callers that go through sshd budget below it. */
export const CMD_EXE_COMMAND_LINE_MAX_CHARS = 8191
const STARTUP_COMMAND_TEXT_MAX_CHARS = 6000
const POWERSHELL_ENCODED_COMMAND_ARG_MAX_CHARS = 28_000
const CMD_UTF8_SETUP_COMMAND = 'chcp 65001 > nul'
export const ORCA_CODEX_LAUNCH_PREFLIGHT_CMD_QUOTE_ENV = 'ORCA_CODEX_LAUNCH_PREFLIGHT_CMD_QUOTE'
const CMD_CODEX_LAUNCH_PREFLIGHT = `if defined ORCA_CODEX_LAUNCH_PREFLIGHT call %${ORCA_CODEX_LAUNCH_PREFLIGHT_CMD_QUOTE_ENV}%%ORCA_CODEX_LAUNCH_PREFLIGHT%%${ORCA_CODEX_LAUNCH_PREFLIGHT_CMD_QUOTE_ENV}% agent hooks prepare-codex > nul 2>&1`
// Git Bash inherits OEM codepage; select UTF-8 before TUIs write bytes, but keep startup working if chcp.com is missing.
const GIT_BASH_UTF8_LOGIN_COMMAND = 'chcp.com 65001 >/dev/null 2>&1; exec "$BASH" --login -i'

// Every Bash pane needs account-following wrappers; the rcfile also owns login startup.
function getGitBashLaunchCommand(): string {
  ensureShellReadyWrappersAt()
  const wrapperArgs = getBashWrapperLaunchArgs()
  if (!wrapperArgs) {
    return GIT_BASH_UTF8_LOGIN_COMMAND
  }
  const bashArgs = [...wrapperArgs, '-i']
    .map((arg) => (arg.startsWith('-') ? arg : quotePosixShell(arg.replace(/\\/g, '/'))))
    .join(' ')
  return `chcp.com 65001 >/dev/null 2>&1; exec "$BASH" ${bashArgs}`
}

/** Shared local/daemon resolution prevents shell-preference drift between execution paths. */
export type WindowsShellLaunchArgs = {
  shellArgs: string[]
  /** Startup is already in argv; suppress a second stdin write. */
  startupCommandDeliveredInShellArgs?: boolean
  /** Native node-pty cwd; WSL launches from Windows home and performs guest cd through argv. */
  effectiveCwd: string
  /** Requested path to validate even when WSL launches from a different native cwd. */
  validationCwd: string
}

export type WindowsShellWslContext = {
  distro: string
  treatPosixCwdAsWsl?: boolean
}

function getCmdShellArgStartupCommand(command?: string): string | null {
  if (!command || command.length > STARTUP_COMMAND_TEXT_MAX_CHARS) {
    return null
  }
  // node-pty C-runtime escaping changes cmd /K quotes; interactive stdin preserves them.
  if (command.includes('"')) {
    return null
  }
  const commandArg = `${CMD_UTF8_SETUP_COMMAND} & ${command}`
  if (commandArg.length > CMD_EXE_COMMAND_LINE_MAX_CHARS) {
    return null
  }
  return command
}

function getPowerShellRestoreCwdCommand(cwd: string): string {
  // Profiles may change directory; restore requested PTY cwd afterward.
  return [
    '',
    `try { Set-Location -LiteralPath ${quoteStartupArg(cwd, 'powershell')} -ErrorAction Stop } catch { Write-Warning "Failed to restore working directory: $_" }`
  ].join('\n')
}

function getPowerShellEncodedCommand(
  cwd: string,
  startupCommand?: string
): {
  encodedCommand: string
  startupCommandDeliveredInShellArgs?: boolean
} {
  const bootstrap = `${getPowerShellOsc133Bootstrap()}${getPowerShellRestoreCwdCommand(cwd)}`
  if (!startupCommand || startupCommand.length > STARTUP_COMMAND_TEXT_MAX_CHARS) {
    return { encodedCommand: encodePowerShellCommand(bootstrap) }
  }

  const command = `${bootstrap}\n${startupCommand}`
  const encodedCommand = encodePowerShellCommand(command)
  // UTF-16/base64 expands payloads; leave margin under CreateProcess 32,767-character limit.
  if (encodedCommand.length > POWERSHELL_ENCODED_COMMAND_ARG_MAX_CHARS) {
    return { encodedCommand: encodePowerShellCommand(bootstrap) }
  }

  return {
    encodedCommand,
    startupCommandDeliveredInShellArgs: true
  }
}

function buildWslShellArgs(linuxCwd: string, distro?: string): string[] {
  ensureShellReadyWrappersAt()
  const setupCommand = [
    `cd ${quotePosixShell(linuxCwd)}`,
    'export PATH="$HOME/.local/bin:$PATH"',
    buildWslInteractiveLoginShellCommand()
  ].join(' && ')
  // Match the distro login shell used by environment detection, including customized zsh.
  return buildWslExecArgs(distro, ['sh', '-c', setupCommand])
}

/** Converts an MSYS drive spelling to the native cwd used by Windows terminal processes. */
export function normalizeWindowsTerminalCwd(cwd: string): string {
  const match = cwd.match(/^\/([A-Za-z])(?:\/(.*))?$/)
  if (!match) {
    return cwd
  }

  const driveLetter = match[1].toUpperCase()
  const rest = match[2]?.replace(/\//g, '\\') ?? ''
  return rest ? `${driveLetter}:\\${rest}` : `${driveLetter}:\\`
}

/** Apply UTF-8/bootstrap profiles, preserve guest cwd, and share argv semantics across local and daemon spawns. */
export function resolveWindowsShellLaunchArgs(
  shellPath: string,
  cwd: string,
  defaultCwd: string,
  wslContext?: WindowsShellWslContext,
  startupCommand?: string,
  codexLaunchPreflightCommand?: string
): WindowsShellLaunchArgs {
  const shellBasename = pathWin32.basename(shellPath).toLowerCase()
  const nativeCwd = normalizeWindowsTerminalCwd(cwd)

  if (shellBasename === 'cmd.exe') {
    const shellArgStartupCommand = getCmdShellArgStartupCommand(startupCommand)
    const startupCommands = [
      CMD_UTF8_SETUP_COMMAND,
      ...(codexLaunchPreflightCommand ? [CMD_CODEX_LAUNCH_PREFLIGHT] : []),
      ...(shellArgStartupCommand ? [shellArgStartupCommand] : [])
    ]
    return {
      shellArgs: ['/K', startupCommands.join(' & ')],
      ...(shellArgStartupCommand ? { startupCommandDeliveredInShellArgs: true } : {}),
      effectiveCwd: nativeCwd,
      validationCwd: nativeCwd
    }
  }

  if (shellBasename === 'powershell.exe' || shellBasename === 'pwsh.exe') {
    const powerShellCommand = getPowerShellEncodedCommand(nativeCwd, startupCommand)
    // Windows status requires OSC 133 prompt/readline hooks after profiles; encoded delivery follows powershell-osc133-bootstrap.ts MDE review.
    return {
      shellArgs: ['-NoLogo', '-NoExit', '-EncodedCommand', powerShellCommand.encodedCommand],
      ...(powerShellCommand.startupCommandDeliveredInShellArgs
        ? { startupCommandDeliveredInShellArgs: true }
        : {}),
      effectiveCwd: nativeCwd,
      validationCwd: nativeCwd
    }
  }

  if (isWindowsGitBashShellPath(shellPath)) {
    return {
      shellArgs: ['-c', getGitBashLaunchCommand()],
      effectiveCwd: nativeCwd,
      validationCwd: nativeCwd
    }
  }

  if (shellBasename === 'wsl.exe') {
    const wslInfo = parseWslPath(cwd)
    if (wslInfo) {
      return {
        shellArgs: buildWslShellArgs(wslInfo.linuxPath, wslInfo.distro),
        effectiveCwd: defaultCwd,
        validationCwd: cwd
      }
    }
    if (wslContext?.treatPosixCwdAsWsl && cwd.startsWith('/')) {
      return {
        shellArgs: buildWslShellArgs(cwd, wslContext.distro),
        effectiveCwd: defaultCwd,
        validationCwd: toWindowsWslPath(cwd, wslContext.distro)
      }
    }
    const driveMatch = nativeCwd.replace(/\\/g, '/').match(/^([A-Za-z]):\/?(.*)$/)
    const linuxCwd = driveMatch ? toLinuxPath(nativeCwd) : '/mnt/c'
    return {
      shellArgs: buildWslShellArgs(linuxCwd, wslContext?.distro),
      effectiveCwd: defaultCwd,
      validationCwd: nativeCwd
    }
  }

  return {
    shellArgs: [],
    effectiveCwd: nativeCwd,
    validationCwd: nativeCwd
  }
}
