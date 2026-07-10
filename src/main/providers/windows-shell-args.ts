import { win32 as pathWin32 } from 'node:path'
import { isWindowsGitBashShellPath } from '../git-bash'
import { parseWslPath, toLinuxPath, toWindowsWslPath } from '../wsl'
import {
  buildWslInteractiveLoginShellCommand,
  escapeWslShCommandForWindows,
  quotePosixShell
} from '../../shared/wsl-login-shell-command'
import { ensureShellReadyWrappersAt } from './local-pty-shell-ready'
import {
  encodePowerShellCommand,
  getPowerShellOsc133Bootstrap
} from '../powershell-osc133-bootstrap'

const CMD_EXE_COMMAND_LINE_MAX_CHARS = 8191
const STARTUP_COMMAND_TEXT_MAX_CHARS = 6000
const POWERSHELL_ENCODED_COMMAND_ARG_MAX_CHARS = 28_000
const CMD_UTF8_SETUP_COMMAND = 'chcp 65001 > nul'

/** Result of resolving a Windows shell to its launch args + effective cwd.
 *
 *  Why this module exists: both the in-process LocalPtyProvider and the
 *  daemon-subprocess spawner must produce IDENTICAL launch args for the same
 *  (shellPath, cwd) pair. A prior drift let the daemon path always spawn
 *  PowerShell regardless of which shell the user picked — the renderer's
 *  shellOverride never reached the daemon's shell-args branches. Sharing the
 *  decision here keeps both paths honest. */
export type WindowsShellLaunchArgs = {
  shellArgs: string[]
  /** True when the startup command was embedded in shellArgs and must not be
   *  written again through stdin. */
  startupCommandDeliveredInShellArgs?: boolean
  /** The cwd node-pty should be spawned with. WSL cannot cd into a Windows
   *  path, so the wsl.exe branch returns the user's home as the effective cwd
   *  and injects `cd '<linux path>'` into shellArgs instead. */
  effectiveCwd: string
  /** The path the caller should still validate exists on disk. Equals cwd in
   *  every branch except wsl.exe (which validates the Windows cwd even though
   *  the shell itself launches from $HOME). */
  validationCwd: string
}

export type WindowsShellWslContext = {
  distro: string
  treatPosixCwdAsWsl?: boolean
}

/**
 * Returns a startup command that is safe to embed in cmd.exe launch args.
 *
 * Commands that could exceed Windows cmd.exe limits return null so callers
 * keep the older stdin delivery path.
 */
function getCmdShellArgStartupCommand(command?: string): string | null {
  if (!command || command.length > STARTUP_COMMAND_TEXT_MAX_CHARS) {
    return null
  }
  const commandArg = `${CMD_UTF8_SETUP_COMMAND} & ${command}`
  if (commandArg.length > CMD_EXE_COMMAND_LINE_MAX_CHARS) {
    return null
  }
  return command
}

/**
 * Builds the PowerShell -EncodedCommand payload for startup bootstrap.
 *
 * Short startup commands are appended to the bootstrap and marked as delivered;
 * large payloads return the bootstrap alone so stdin delivery remains available.
 */
function getPowerShellEncodedCommand(startupCommand?: string): {
  encodedCommand: string
  startupCommandDeliveredInShellArgs?: boolean
} {
  const bootstrap = getPowerShellOsc133Bootstrap()
  if (!startupCommand || startupCommand.length > STARTUP_COMMAND_TEXT_MAX_CHARS) {
    return { encodedCommand: encodePowerShellCommand(bootstrap) }
  }

  const command = `${bootstrap}\n${startupCommand}`
  const encodedCommand = encodePowerShellCommand(command)
  // Why: -EncodedCommand expands UTF-16 text into base64; keep a conservative
  // margin under Windows CreateProcess' 32,767-character command line limit.
  if (encodedCommand.length > POWERSHELL_ENCODED_COMMAND_ARG_MAX_CHARS) {
    return { encodedCommand: encodePowerShellCommand(bootstrap) }
  }

  return {
    encodedCommand,
    startupCommandDeliveredInShellArgs: true
  }
}

/**
 * Builds wsl.exe arguments that enter the target directory through the distro shell.
 */
function buildWslShellArgs(linuxCwd: string, distro?: string): string[] {
  ensureShellReadyWrappersAt()
  const setupCommand = [
    `cd ${quotePosixShell(linuxCwd)}`,
    'export PATH="$HOME/.local/bin:$PATH"',
    buildWslInteractiveLoginShellCommand()
  ].join(' && ')
  // Why: WSL users often customize zsh rather than bash; launch the distro's
  // login shell so terminal PATH matches the environment Orca detects.
  const shellArgs = ['--', 'sh', '-c', escapeWslShCommandForWindows(setupCommand)]
  return distro ? ['-d', distro, ...shellArgs] : shellArgs
}

function normalizeMsysDrivePath(cwd: string): string {
  const match = cwd.match(/^\/([A-Za-z])(?:\/(.*))?$/)
  if (!match) {
    return cwd
  }

  // Why: Git Bash/MSYS launch contexts can hand Windows terminals `/d/repo`;
  // ConPTY requires the equivalent native drive path as its cwd.
  const driveLetter = match[1].toUpperCase()
  const rest = match[2]?.replace(/\//g, '\\') ?? ''
  return rest ? `${driveLetter}:\\${rest}` : `${driveLetter}:\\`
}

/** Build the argv + effective cwd for a Windows shell launch.
 *
 *  - cmd.exe: `/K chcp 65001 > nul` so multi-byte CJK output renders correctly.
 *  - powershell.exe / pwsh.exe: dot-source $PROFILE and force UTF-8 I/O so
 *    oh-my-posh / starship / PSReadLine keep working. `-NoExit` alone would
 *    skip the profile.
 *  - wsl.exe: translate the Windows cwd to /mnt/<drive>/... and enter the
 *    distro user's login shell.
 *  - anything else: no args, same cwd. */
export function resolveWindowsShellLaunchArgs(
  shellPath: string,
  cwd: string,
  defaultCwd: string,
  wslContext?: WindowsShellWslContext,
  startupCommand?: string
): WindowsShellLaunchArgs {
  const shellBasename = pathWin32.basename(shellPath).toLowerCase()
  const nativeCwd = normalizeMsysDrivePath(cwd)
  const isMsysDriveCwd = nativeCwd !== cwd

  if (shellBasename === 'cmd.exe') {
    const shellArgStartupCommand = getCmdShellArgStartupCommand(startupCommand)
    return {
      shellArgs: [
        '/K',
        shellArgStartupCommand
          ? `${CMD_UTF8_SETUP_COMMAND} & ${shellArgStartupCommand}`
          : CMD_UTF8_SETUP_COMMAND
      ],
      ...(shellArgStartupCommand ? { startupCommandDeliveredInShellArgs: true } : {}),
      effectiveCwd: nativeCwd,
      validationCwd: nativeCwd
    }
  }

  if (shellBasename === 'powershell.exe' || shellBasename === 'pwsh.exe') {
    const powerShellCommand = getPowerShellEncodedCommand(startupCommand)
    // Why: foreground-process status on Windows depends on OSC 133 C/D, and
    // PowerShell needs a prompt/readline bootstrap after profiles finish.
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
      shellArgs: ['--login', '-i'],
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
    if (wslContext?.treatPosixCwdAsWsl && cwd.startsWith('/') && !isMsysDriveCwd) {
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
