import { win32 as pathWin32 } from 'path'
import { isWindowsGitBashShellPath } from '../git-bash'
import { parseWslPath, toLinuxPath, toWindowsWslPath } from '../wsl'
import {
  buildWslInteractiveLoginShellCommand,
  escapeWslShCommandForWindows,
  quotePosixShell
} from '../../shared/wsl-login-shell-command'
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

const CODEX_HISTORY_DISABLED_BASH_BOOTSTRAP =
  // Why: Codex applies later/subcommand -c overrides last; keep safety after user args.
  'if [[ -n "${ORCA_CODEX_HOME:-}" ]]; then codex() { local -a _orca_codex_args; local _orca_codex_inserted=0; local _orca_codex_arg; export CODEX_HOME="${ORCA_CODEX_HOME}"; for _orca_codex_arg in "$@"; do if [[ "${_orca_codex_inserted}" == "0" && "${_orca_codex_arg}" == "--" ]]; then _orca_codex_args+=(-c \'history.persistence="none"\'); _orca_codex_inserted=1; fi; _orca_codex_args+=("${_orca_codex_arg}"); done; if [[ "${_orca_codex_inserted}" == "0" ]]; then _orca_codex_args+=(-c \'history.persistence="none"\'); fi; command codex "${_orca_codex_args[@]}"; }; export -f codex; fi'
const CODEX_HISTORY_DISABLED_WSL_SH_BOOTSTRAP = `if [ -n "\${ORCA_CODEX_HOME:-}" ]; then
  if ! _orca_codex_bin=$(mktemp -d "\${TMPDIR:-/tmp}/orca-codex-history.XXXXXX"); then
    echo "failed to create Orca Codex wrapper directory" >&2
    exit 1
  fi
  if ! chmod 700 "\${_orca_codex_bin}"; then
    rm -rf "\${_orca_codex_bin}"
    echo "failed to secure Orca Codex wrapper directory" >&2
    exit 1
  fi
  if ! cat > "\${_orca_codex_bin}/codex" <<'__ORCA_CODEX_WRAPPER__'
#!/bin/sh
_orca_wrapper_dir="\${ORCA_CODEX_WRAPPER_DIR:-}"
_orca_original_path="\${PATH:-}"
_orca_search_path=""
_orca_old_ifs=$IFS
IFS=:
for _orca_path_entry in \${_orca_original_path}; do
  if [ -n "\${_orca_wrapper_dir}" ] && [ "\${_orca_path_entry}" = "\${_orca_wrapper_dir}" ]; then
    continue
  fi
  if [ -z "\${_orca_search_path}" ]; then
    _orca_search_path="\${_orca_path_entry}"
  else
    _orca_search_path="\${_orca_search_path}:\${_orca_path_entry}"
  fi
done
IFS=$_orca_old_ifs
_orca_real_codex=$(PATH="\${_orca_search_path}" command -v codex 2>/dev/null || true)
if [ -z "\${_orca_real_codex}" ]; then
  echo "codex executable not found" >&2
  exit 127
fi
_orca_codex_inserted=0
export CODEX_HOME="\${ORCA_CODEX_HOME}"
# Why: Codex applies later/subcommand -c overrides last; keep safety after user args.
_orca_remaining=$#
while [ "\${_orca_remaining}" -gt 0 ]; do
  _orca_codex_arg=$1
  shift
  _orca_remaining=$((_orca_remaining - 1))
  if [ "\${_orca_codex_inserted}" = "0" ] && [ "\${_orca_codex_arg}" = "--" ]; then
    set -- "$@" -c 'history.persistence="none"'
    _orca_codex_inserted=1
  fi
  set -- "$@" "\${_orca_codex_arg}"
done
if [ "\${_orca_codex_inserted}" = "0" ]; then
  set -- "$@" -c 'history.persistence="none"'
fi
exec "\${_orca_real_codex}" "$@"
__ORCA_CODEX_WRAPPER__
  then
    rm -rf "\${_orca_codex_bin}"
    echo "failed to write Orca Codex wrapper" >&2
    exit 1
  fi
  if ! chmod +x "\${_orca_codex_bin}/codex"; then
    rm -rf "\${_orca_codex_bin}"
    echo "failed to make Orca Codex wrapper executable" >&2
    exit 1
  fi
  export ORCA_CODEX_WRAPPER_DIR="\${_orca_codex_bin}"
  export PATH="\${_orca_codex_bin}:$PATH"
  _orca_cleanup_codex_wrapper_dir() {
    # Why: only delete wrapper dirs created by this bootstrap, never arbitrary paths.
    case "\${ORCA_CODEX_WRAPPER_DIR:-}" in
      */orca-codex-history.*) rm -rf "\${ORCA_CODEX_WRAPPER_DIR}" ;;
    esac
  }
  trap _orca_cleanup_codex_wrapper_dir 0
fi`

export function getWslCodexHistoryBootstrap(): string {
  return CODEX_HISTORY_DISABLED_WSL_SH_BOOTSTRAP
}
const CODEX_HISTORY_DISABLED_CMD_BOOTSTRAP =
  // Why: Codex applies later/subcommand -c overrides last; keep safety after user args.
  "if defined ORCA_CODEX_HOME doskey codex=powershell.exe -NoLogo -Command \"$$orcaCodexCommand=Get-Command codex -CommandType Application -ErrorAction SilentlyContinue ^| Select-Object -First 1;if($$null -eq $$orcaCodexCommand){throw 'codex executable not found'};$$orcaCodexArgs=[System.Collections.Generic.List[string]]::new();$$orcaCodexInserted=$$false;foreach($$arg in $$args){if(-not $$orcaCodexInserted -and $$arg -eq '--'){[void]$$orcaCodexArgs.Add('-c');[void]$$orcaCodexArgs.Add('history.persistence=none');$$orcaCodexInserted=$$true};[void]$$orcaCodexArgs.Add($$arg)};if(-not $$orcaCodexInserted){[void]$$orcaCodexArgs.Add('-c');[void]$$orcaCodexArgs.Add('history.persistence=none')};$$env:CODEX_HOME=$$env:ORCA_CODEX_HOME;& $$orcaCodexCommand.Source @($$orcaCodexArgs.ToArray())\" $*"

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
  const setupCommand = [
    `cd ${quotePosixShell(linuxCwd)}`,
    'export PATH="$HOME/.local/bin:$PATH"',
    buildWslInteractiveLoginShellCommand(getWslCodexHistoryBootstrap())
  ].join(' && ')
  // Why: WSL users often customize zsh rather than bash; launch the distro's
  // login shell so terminal PATH matches the environment Orca detects.
  const shellArgs = ['--', 'sh', '-c', escapeWslShCommandForWindows(setupCommand)]
  return distro ? ['-d', distro, ...shellArgs] : shellArgs
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

  if (shellBasename === 'cmd.exe') {
    const shellArgStartupCommand = getCmdShellArgStartupCommand(startupCommand)
    const setupCommand = shellArgStartupCommand
      ? `${CMD_UTF8_SETUP_COMMAND} & ${CODEX_HISTORY_DISABLED_CMD_BOOTSTRAP} & ${shellArgStartupCommand}`
      : `${CMD_UTF8_SETUP_COMMAND} & ${CODEX_HISTORY_DISABLED_CMD_BOOTSTRAP}`
    return {
      shellArgs: ['/K', setupCommand],
      ...(shellArgStartupCommand ? { startupCommandDeliveredInShellArgs: true } : {}),
      effectiveCwd: cwd,
      validationCwd: cwd
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
      effectiveCwd: cwd,
      validationCwd: cwd
    }
  }

  if (isWindowsGitBashShellPath(shellPath)) {
    return {
      shellArgs: ['-c', `${CODEX_HISTORY_DISABLED_BASH_BOOTSTRAP}; exec bash --login -i`],
      effectiveCwd: cwd,
      validationCwd: cwd
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
    const driveMatch = cwd.replace(/\\/g, '/').match(/^([A-Za-z]):\/?(.*)$/)
    const linuxCwd = driveMatch ? toLinuxPath(cwd) : '/mnt/c'
    return {
      shellArgs: buildWslShellArgs(linuxCwd, wslContext?.distro),
      effectiveCwd: defaultCwd,
      validationCwd: cwd
    }
  }

  return {
    shellArgs: [],
    effectiveCwd: cwd,
    validationCwd: cwd
  }
}
