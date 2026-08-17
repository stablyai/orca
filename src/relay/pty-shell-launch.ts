import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { getPosixOmpShellWrapper } from '../main/pty/omp-shell-wrapper'
import {
  BASH_PROMPT_COMMAND_COMPOSITION_BLOCK,
  getZshFinalZdotdirRestoreBlock,
  getZshShellReadyMarkerRegistrationBlock,
  SHELL_STARTUP_IDENTITY_MARKER_BLOCK,
  getZshStartupFileSourceBlock
} from '../main/shell-templates'

const RELAY_SHELL_READY_DIR = '.orca-relay/shell-ready'
const POSIX_LOGIN_ARGS = ['-l']
const SHELL_READY_MARKER_ESCAPED = '\\033]777;orca-shell-ready\\007'

export type RelayShellLaunchConfig = {
  args: string[]
  env: Record<string, string>
}

function quotePosixSingle(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function shellBasename(shellPath: string): string {
  return shellPath.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? ''
}

function windowsShellArgs(
  shellName: string,
  options: { terminalWindowsWslDistro?: string | null } = {}
): string[] | null {
  if (shellName === 'powershell.exe' || shellName === 'powershell') {
    return ['-NoLogo']
  }
  if (shellName === 'pwsh.exe' || shellName === 'pwsh') {
    return ['-NoLogo']
  }
  if (shellName === 'cmd.exe' || shellName === 'cmd') {
    return []
  }
  if (shellName === 'wsl.exe' || shellName === 'wsl') {
    const distro = options.terminalWindowsWslDistro?.trim()
    return distro ? ['-d', distro] : []
  }
  return null
}

function hasOverlayRestoreEnv(env: Record<string, string>): boolean {
  return Boolean(
    env.ORCA_OPENCODE_CONFIG_DIR ||
    env.ORCA_MIMOCODE_HOME ||
    env.ORCA_REMOTE_CLI_BIN_DIR ||
    env.ORCA_OMP_STATUS_EXTENSION
  )
}

function getWrapperRoot(env: Record<string, string>): string {
  return join(env.HOME || process.env.HOME || homedir(), RELAY_SHELL_READY_DIR)
}

function normalizeOriginalZdotdirCandidate(value: string | undefined): string | null {
  if (!value) {
    return null
  }
  const normalized = value.replace(/\/+$/, '')
  if (!normalized || normalized.endsWith('/shell-ready/zsh')) {
    return null
  }
  return value
}

function resolveOriginalZdotdir(env: Record<string, string>): string {
  return (
    normalizeOriginalZdotdirCandidate(env.ZDOTDIR) ||
    normalizeOriginalZdotdirCandidate(env.ORCA_ORIG_ZDOTDIR) ||
    env.HOME ||
    process.env.HOME ||
    ''
  )
}

function ensureOverlayRestoreWrappers(root: string): void {
  const zshDir = join(root, 'zsh')
  const bashDir = join(root, 'bash')

  const zshEnv = `# Orca relay zsh overlay wrapper
${SHELL_STARTUP_IDENTITY_MARKER_BLOCK}
export ORCA_ORIG_ZDOTDIR="\${ORCA_ORIG_ZDOTDIR:-$HOME}"
case "\${ORCA_ORIG_ZDOTDIR%/}" in
  */shell-ready/zsh) export ORCA_ORIG_ZDOTDIR="$HOME" ;;
esac
[[ -f "$ORCA_ORIG_ZDOTDIR/.zshenv" ]] && source "$ORCA_ORIG_ZDOTDIR/.zshenv"
export ORCA_USER_ZDOTDIR="\${ZDOTDIR:-\${ORCA_ORIG_ZDOTDIR:-$HOME}}"
case "\${ORCA_USER_ZDOTDIR%/}" in
  */shell-ready/zsh) export ORCA_USER_ZDOTDIR="$HOME" ;;
esac
export ZDOTDIR=${quotePosixSingle(zshDir)}
`
  const zshProfile = `# Orca relay zsh overlay wrapper
${getZshStartupFileSourceBlock({
  fileName: '.zprofile',
  homeExpression: '"${ORCA_USER_ZDOTDIR:-${ORCA_ORIG_ZDOTDIR:-$HOME}}"'
})}
`
  const zshRc = `# Orca relay zsh overlay wrapper
${getZshStartupFileSourceBlock({
  fileName: '.zshrc',
  homeExpression: '"${ORCA_USER_ZDOTDIR:-${ORCA_ORIG_ZDOTDIR:-$HOME}}"',
  interactiveOnly: true
})}
if [[ ! -o login ]]; then
  # Why: remote startup files can re-export user defaults after relay spawn.
  [[ -n "\${ORCA_OPENCODE_CONFIG_DIR:-}" ]] && export OPENCODE_CONFIG_DIR="\${ORCA_OPENCODE_CONFIG_DIR}"
  [[ -n "\${ORCA_MIMOCODE_HOME:-}" ]] && export MIMOCODE_HOME="\${ORCA_MIMOCODE_HOME}"
  [[ -n "\${ORCA_REMOTE_CLI_BIN_DIR:-}" ]] && case ":$PATH:" in *:"\${ORCA_REMOTE_CLI_BIN_DIR}":*) ;; *) export PATH="\${ORCA_REMOTE_CLI_BIN_DIR}:$PATH" ;; esac
  ${getPosixOmpShellWrapper()}
fi
if [[ ! -o login ]]; then
${getZshFinalZdotdirRestoreBlock('"${ORCA_USER_ZDOTDIR:-${ORCA_ORIG_ZDOTDIR:-$HOME}}"')}
fi
`
  const zshLogin = `# Orca relay zsh overlay wrapper
${getZshStartupFileSourceBlock({
  fileName: '.zlogin',
  homeExpression: '"${ORCA_USER_ZDOTDIR:-${ORCA_ORIG_ZDOTDIR:-$HOME}}"',
  interactiveOnly: true
})}
# Why: .zlogin is the final zsh login startup file before the prompt.
[[ -n "\${ORCA_OPENCODE_CONFIG_DIR:-}" ]] && export OPENCODE_CONFIG_DIR="\${ORCA_OPENCODE_CONFIG_DIR}"
[[ -n "\${ORCA_MIMOCODE_HOME:-}" ]] && export MIMOCODE_HOME="\${ORCA_MIMOCODE_HOME}"
[[ -n "\${ORCA_REMOTE_CLI_BIN_DIR:-}" ]] && case ":$PATH:" in *:"\${ORCA_REMOTE_CLI_BIN_DIR}":*) ;; *) export PATH="\${ORCA_REMOTE_CLI_BIN_DIR}:$PATH" ;; esac
${getPosixOmpShellWrapper()}
${getZshFinalZdotdirRestoreBlock('"${ORCA_USER_ZDOTDIR:-${ORCA_ORIG_ZDOTDIR:-$HOME}}"')}
${getZshShellReadyMarkerRegistrationBlock(SHELL_READY_MARKER_ESCAPED)}
`
  const bashRc = `# Orca relay bash overlay wrapper
${SHELL_STARTUP_IDENTITY_MARKER_BLOCK}
[[ -f /etc/profile ]] && source /etc/profile
if [[ -f "$HOME/.bash_profile" ]]; then
  source "$HOME/.bash_profile"
elif [[ -f "$HOME/.bash_login" ]]; then
  source "$HOME/.bash_login"
elif [[ -f "$HOME/.profile" ]]; then
  source "$HOME/.profile"
fi
# Why: enable bracketed paste so Orca can deliver a multiline startup prompt as
# a single literal paste (ESC[200~…ESC[201~); without it, older readline builds
# treat each embedded newline as Enter and mangle the prompt into PS2
# continuation. Modern readline defaults this on; force it for the rest.
[[ $- == *i* ]] && bind 'set enable-bracketed-paste on' 2>/dev/null
# Why: remote startup files can re-export user defaults after relay spawn.
[[ -n "\${ORCA_OPENCODE_CONFIG_DIR:-}" ]] && export OPENCODE_CONFIG_DIR="\${ORCA_OPENCODE_CONFIG_DIR}"
[[ -n "\${ORCA_MIMOCODE_HOME:-}" ]] && export MIMOCODE_HOME="\${ORCA_MIMOCODE_HOME}"
[[ -n "\${ORCA_REMOTE_CLI_BIN_DIR:-}" ]] && case ":$PATH:" in *:"\${ORCA_REMOTE_CLI_BIN_DIR}":*) ;; *) export PATH="\${ORCA_REMOTE_CLI_BIN_DIR}:$PATH" ;; esac
${getPosixOmpShellWrapper()}
# Why: SSH bash sessions need the same command lifecycle markers as local
# bash so agent rows stop showing "working" when the foreground command exits.
__orca_initializing_wrapper=1
__orca_osc133_precmd() {
  local exit_code=$?
  __orca_in_prompt_command=1
  if [[ -n "\${__orca_in_command:-}" ]]; then
    printf "\\033]133;D;%s\\007" "$exit_code"
    unset __orca_in_command
  fi
  printf "\\033]133;A\\007"
  return "$exit_code"
}
__orca_osc133_prompt_done() {
  unset __orca_in_prompt_command; __orca_adopt_outer_debug_trap
  trap '__orca_osc133_preexec' DEBUG
}
__orca_osc133_preexec() {
  if [[ -n "\${__orca_prompt_status_capture_command:-}" && "$BASH_COMMAND" == "$__orca_prompt_status_capture_command" ]]; then
    unset __orca_initial_prompt
    __orca_in_legacy_prompt_wrapper=1
    return 0
  fi
  if [[ -n "\${__orca_initializing_wrapper:-}\${__orca_in_debug_capture:-}\${__orca_initial_prompt:-}\${__orca_in_prompt_dispatch:-}\${__orca_in_legacy_prompt_wrapper:-}\${__orca_in_prompt_command:-}" ]]; then
    [[ -z "\${__orca_initializing_wrapper:-}\${__orca_in_debug_capture:-}" ]] || return 0
    if [[ -n "\${__orca_initial_prompt:-}" && "$BASH_COMMAND" == "__orca_osc133_precmd" ]]; then
      unset __orca_initial_prompt; return 0
    fi
    if [[ -n "\${__orca_in_prompt_dispatch:-}" ]]; then
      [[ -n "\${__orca_dispatching_user_prompt_command:-}" ]] || return 0
      if [[ "\${FUNCNAME[1]:-}" == "__orca_run_prompt_command_array" ]]; then
        case "$BASH_COMMAND" in
          '(( __orca_exit_code == 0 ))'|'__orca_restore_prompt_status "$__orca_exit_code"'|'eval "$__orca_prompt_part"'|'eval "$__orca_final_prompt_command"'|__orca_dispatching_user_prompt_command=*|__orca_osc133_precmd|__orca_osc133_prompt_done|__orca_prompt_mark) return 0 ;;
        esac
      fi
    elif [[ "\${FUNCNAME[1]:-}" == "__orca_run_prompt_command_array" || "$BASH_COMMAND" == "__orca_run_prompt_command_array" ]]; then
      return 0
    fi
    [[ -z "\${__orca_in_legacy_prompt_wrapper:-}" || -n "\${__orca_dispatching_user_prompt_command:-}" ]] || return 0
    if [[ -n "\${__orca_in_prompt_command:-}" && "$BASH_COMMAND" == "__orca_in_debug_capture=1" ]]; then
      return 0
    fi
  fi
  case "\${FUNCNAME[1]:-}" in __orca_osc133_*|__orca_prompt_mark|__orca_restore_prompt_status) return 0 ;; esac
  case "$BASH_COMMAND" in __orca_osc133_precmd|__orca_osc133_prompt_done|__orca_prompt_mark) return 0 ;; esac
  __orca_run_user_debug_trap
  [[ -z "\${__orca_in_prompt_command:-}" ]] || return 0
  [[ -z "\${__orca_in_command:-}" ]] || return 0
  printf "\\033]133;C\\007"
  __orca_in_command=1
}
${BASH_PROMPT_COMMAND_COMPOSITION_BLOCK}
__orca_prepend_prompt_command "__orca_osc133_precmd"
# Why: SSH startup commands are renderer-delivered; emit the same internal
# readiness marker as local shells only when that delivery mode asks for it.
if [[ "\${ORCA_SHELL_READY_MARKER:-0}" == "1" ]]; then
  __orca_prompt_mark() {
    printf "${SHELL_READY_MARKER_ESCAPED}"
  }
  __orca_append_prompt_command "__orca_prompt_mark"
fi
__orca_append_prompt_command '__orca_in_debug_capture=1; __orca_prompt_had_functrace=""; if [[ -o functrace ]]; then __orca_prompt_had_functrace=1; set +T; fi; __orca_outer_debug_trap_spec="$(trap -p DEBUG)"; [[ -z "$__orca_prompt_had_functrace" ]] || set -T; unset __orca_prompt_had_functrace __orca_in_debug_capture'
__orca_append_prompt_command "__orca_osc133_prompt_done"
__orca_had_functrace=""
[[ -o functrace ]] && __orca_had_functrace=1
set +T
__orca_debug_trap_spec="$(trap -p DEBUG)"
[[ -z "$__orca_had_functrace" ]] || set -T
if [[ -n "$__orca_debug_trap_spec" && "$__orca_debug_trap_spec" != "trap -- '__orca_osc133_preexec' DEBUG" ]]; then
  __orca_debug_trap_command="\${__orca_debug_trap_spec#trap -- }"
  __orca_debug_trap_command="\${__orca_debug_trap_command% DEBUG}"
  eval "__orca_user_debug_trap=$__orca_debug_trap_command"
fi
unset __orca_debug_trap_spec __orca_debug_trap_command __orca_had_functrace
unset -f __orca_normalize_prompt_command_part __orca_normalize_prompt_command __orca_prepend_prompt_command __orca_append_prompt_command
unset __orca_prompt_command_normalized
# Why: arm DEBUG after wrapper setup so the relay rcfile itself does not emit
# fake command-start/end markers before the first prompt.
__orca_initial_prompt=1
trap '__orca_osc133_preexec' DEBUG
unset __orca_initializing_wrapper
`

  const files = [
    [join(zshDir, '.zshenv'), zshEnv],
    [join(zshDir, '.zprofile'), zshProfile],
    [join(zshDir, '.zshrc'), zshRc],
    [join(zshDir, '.zlogin'), zshLogin],
    [join(bashDir, 'rcfile'), bashRc]
  ] as const

  for (const [path, content] of files) {
    mkdirSync(dirname(path), { recursive: true })
    let existing: string | null = null
    try {
      existing = readFileSync(path, 'utf8')
    } catch {
      existing = null
    }
    // Why: relay wrapper files persist under ~/.orca-relay across app
    // upgrades. Existence alone is not enough; stale wrappers would miss
    // later fixes such as preserving post-.zshenv ZDOTDIR.
    if (existing !== content) {
      writeFileSync(path, content, 'utf8')
    }
    chmodSync(path, 0o644)
  }
}

export function getRelayShellLaunchConfig(
  shellPath: string,
  env: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
  options: {
    emitReadyMarker?: boolean
    emitStartupIdentity?: boolean
    terminalWindowsWslDistro?: string | null
  } = {}
): RelayShellLaunchConfig {
  const shellName = shellBasename(shellPath)
  const emitReadyMarker = options.emitReadyMarker === true
  const emitStartupIdentity = options.emitStartupIdentity === true
  if (platform === 'win32') {
    // Why: pwsh also exists on POSIX remotes; Windows-specific shell args must
    // only apply when the relay itself is running on native Windows.
    return {
      args:
        windowsShellArgs(shellName, {
          terminalWindowsWslDistro: options.terminalWindowsWslDistro
        }) ?? [],
      env: {}
    }
  }

  if (shellName !== 'zsh' && shellName !== 'bash') {
    return { args: POSIX_LOGIN_ARGS, env: {} }
  }
  // Why: preserve plain zsh startup fast path unless markers or overlay restoration are requested.
  const requiresZshWrapper = hasOverlayRestoreEnv(env) || emitReadyMarker || emitStartupIdentity
  if (shellName === 'zsh' && !requiresZshWrapper) {
    return { args: POSIX_LOGIN_ARGS, env: {} }
  }

  const root = getWrapperRoot(env)
  ensureOverlayRestoreWrappers(root)

  if (shellName === 'zsh') {
    return {
      args: POSIX_LOGIN_ARGS,
      env: {
        ORCA_ORIG_ZDOTDIR: resolveOriginalZdotdir(env),
        ZDOTDIR: join(root, 'zsh'),
        ...(emitReadyMarker ? { ORCA_SHELL_READY_MARKER: '1' } : {}),
        ...(emitStartupIdentity ? { ORCA_SHELL_STARTUP_IDENTITY: '1' } : {})
      }
    }
  }

  return {
    args: ['--rcfile', join(root, 'bash', 'rcfile')],
    env: {
      ...(emitReadyMarker ? { ORCA_SHELL_READY_MARKER: '1' } : {}),
      ...(emitStartupIdentity ? { ORCA_SHELL_STARTUP_IDENTITY: '1' } : {})
    }
  }
}
