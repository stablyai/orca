import { tmpdir } from 'os'
import { basename, dirname, join, win32 as pathWin32 } from 'path'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import {
  encodePowerShellCommand,
  getPowerShellOsc133Bootstrap,
  isPowerShellExecutableName
} from '../powershell-osc133-bootstrap'

const ORCA_USER_DATA_PATH_ENV = 'ORCA_USER_DATA_PATH'
const SHELL_READY_MARKER = '\\033]777;orca-shell-ready\\007'

let didEnsureShellReadyWrappers = false

function quotePosixSingle(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function getShellReadyWrapperRoot(): string {
  const userDataPath = process.env[ORCA_USER_DATA_PATH_ENV]
  // Why: older/test launchers may not seed ORCA_USER_DATA_PATH. Keep a
  // fallback so daemon startup does not fail before the parent can be fixed.
  return join(userDataPath || tmpdir(), userDataPath ? 'shell-ready' : 'orca-shell-ready')
}

// Why: if our own process inherited ZDOTDIR from a parent shell that was
// itself an Orca PTY (e.g. the user launched Orca from a terminal inside a
// running Orca), that ZDOTDIR points at an Orca shell-ready wrapper dir.
// Propagating it as the new PTY's ORCA_ORIG_ZDOTDIR makes the wrapper's
// `source "$ORCA_ORIG_ZDOTDIR/.zshenv"` line source itself recursively —
// zsh gives "job table full or recursion limit exceeded" and the shell
// never reaches a usable prompt.
//
// Any path component ending in `/shell-ready/zsh` is an Orca wrapper dir
// (regardless of whether it came from this daemon's userData, a packaged
// Orca, or a different dev build). Treat it as if ZDOTDIR were unset so the
// caller falls back to HOME for the user's real config root.
function normalizeOriginalZdotdirCandidate(value: string | undefined): string | null {
  if (!value) {
    return null
  }
  // Why: tolerate trailing slashes — some shell startup scripts export
  // `ZDOTDIR="$dir/"`, and without normalization the suffix check would
  // miss the self-loop path and restore the recursion bug. Also collapses
  // a pathological `ZDOTDIR=/` to empty so we fall back to HOME rather than
  // sourcing `/.zshenv` (which is never the user's real config).
  const normalized = value.replace(/\/+$/, '')
  if (!normalized || normalized.endsWith('/shell-ready/zsh')) {
    return null
  }
  return value
}

function resolveOriginalZdotdir(): string {
  return (
    normalizeOriginalZdotdirCandidate(process.env.ZDOTDIR) ||
    normalizeOriginalZdotdirCandidate(process.env.ORCA_ORIG_ZDOTDIR) ||
    process.env.HOME ||
    ''
  )
}

function getRequiredShellReadyWrapperPaths(root = getShellReadyWrapperRoot()): string[] {
  return [
    join(root, 'zsh', '.zshenv'),
    join(root, 'zsh', '.zprofile'),
    join(root, 'zsh', '.zshrc'),
    join(root, 'zsh', '.zlogin'),
    join(root, 'bash', 'rcfile')
  ]
}

function shellReadyWrappersExist(): boolean {
  return getRequiredShellReadyWrapperPaths().every((path) => existsSync(path))
}

export function getDaemonZshShellReadyRcfileContent(): string {
  return `# Orca daemon zsh shell-ready wrapper
_orca_home="\${ORCA_ORIG_ZDOTDIR:-$HOME}"
if [[ "$_orca_home" != "$ZDOTDIR" && -o interactive && -f "$_orca_home/.zshrc" ]]; then
  source "$_orca_home/.zshrc"
fi
__orca_restore_attribution_path() {
  [[ -n "\${ORCA_ATTRIBUTION_SHIM_DIR:-}" ]] || return 0
  case "$PATH" in
    "\${ORCA_ATTRIBUTION_SHIM_DIR}"|"\${ORCA_ATTRIBUTION_SHIM_DIR}:"*) return 0 ;;
  esac
  export PATH="\${ORCA_ATTRIBUTION_SHIM_DIR}:$PATH"
}
[[ ! -o login ]] && __orca_restore_attribution_path
if [[ ! -o login ]]; then
  # Why: ~/.zshrc can export the user's default OpenCode config after spawn.
  [[ -n "\${ORCA_OPENCODE_CONFIG_DIR:-}" ]] && export OPENCODE_CONFIG_DIR="\${ORCA_OPENCODE_CONFIG_DIR}"
  # Why: PI_CODING_AGENT_DIR must keep the same PTY-scoped overlay after rc files.
  [[ -n "\${ORCA_PI_CODING_AGENT_DIR:-}" ]] && export PI_CODING_AGENT_DIR="\${ORCA_PI_CODING_AGENT_DIR}"
fi
__orca_osc133_precmd() {
  local exit_code=$?
  if [[ -n "\${__orca_in_command:-}" ]]; then
    printf "\\033]133;D;%s\\007" "$exit_code"
    unset __orca_in_command
  fi
  printf "\\033]133;A\\007"
}
__orca_osc133_preexec() {
  printf "\\033]133;C\\007"
  __orca_in_command=1
}
# Why: prepend so Orca captures $? before user prompt hooks can overwrite it.
precmd_functions=(__orca_osc133_precmd \${precmd_functions[@]})
preexec_functions=(__orca_osc133_preexec \${preexec_functions[@]})
`
}

function ensureShellReadyWrappers(): void {
  if (process.platform === 'win32') {
    return
  }
  if (didEnsureShellReadyWrappers && shellReadyWrappersExist()) {
    return
  }
  didEnsureShellReadyWrappers = true

  const root = getShellReadyWrapperRoot()
  const zshDir = join(root, 'zsh')
  const bashDir = join(root, 'bash')

  const zshEnv = `# Orca daemon zsh shell-ready wrapper
_orca_spawn_orig_zdotdir="\${ORCA_ORIG_ZDOTDIR:-}"
# Why: clearing ZDOTDIR lets user .zshenv use the canonical XDG idiom
# \`export ZDOTDIR="\${ZDOTDIR:-$XDG_CONFIG_HOME/zsh}"\` to compute its
# preferred dir; pre-setting it (even to HOME) defeats that default.
unset ZDOTDIR
# Why: function isolates user .zshenv \`return\` so it doesn't abort our wrapper.
# Trade-off: top-level \`setopt LOCAL_OPTIONS\`/\`LOCAL_TRAPS\`, \`TRAPEXIT\`, and
# bare \`local\`/\`typeset\` in user .zshenv become function-scoped; use \`typeset -g\`
# or \`export\` to escape.
__orca_source_user_zshenv() {
  # Why: honor an externally-set ZDOTDIR (login manager, /etc/zshenv, parent
  # shell) so users whose real .zshenv lives at $ZDOTDIR (not $HOME) still
  # get PATH/aliases/exports loaded. Falls back to $HOME when no spawn-env
  # ZDOTDIR was inherited.
  local _orca_user_zdotdir="\${_orca_spawn_orig_zdotdir:-$HOME}"
  [[ -f "$_orca_user_zdotdir/.zshenv" ]] && source "$_orca_user_zdotdir/.zshenv"
}
__orca_source_user_zshenv
unfunction __orca_source_user_zshenv
# Why: prefer the ZDOTDIR user .zshenv resolved (XDG case); else preserve
# the spawn-env value (an inherited resolution from a parent Orca PTY);
# else HOME.
export ORCA_ORIG_ZDOTDIR="\${ZDOTDIR:-\${_orca_spawn_orig_zdotdir:-$HOME}}"
unset _orca_spawn_orig_zdotdir
# Why: strip trailing slashes (matches Node-side normalizer) before the
# self-loop check, so a wrapper-shaped ZDOTDIR with one or more trailing
# slashes still gets normalized away from .zprofile/.zshrc/.zlogin.
while [[ "\${ORCA_ORIG_ZDOTDIR}" == */ ]]; do
  ORCA_ORIG_ZDOTDIR="\${ORCA_ORIG_ZDOTDIR%/}"
done
case "\${ORCA_ORIG_ZDOTDIR}" in
  */shell-ready/zsh) export ORCA_ORIG_ZDOTDIR="$HOME" ;;
esac
export ZDOTDIR=${quotePosixSingle(zshDir)}
`
  const zshProfile = `# Orca daemon zsh shell-ready wrapper
_orca_home="\${ORCA_ORIG_ZDOTDIR:-$HOME}"
case "\${_orca_home%/}" in
  */shell-ready/zsh) _orca_home="$HOME" ;;
esac
[[ -f "$_orca_home/.zprofile" ]] && source "$_orca_home/.zprofile"
`
  const zshRc = getDaemonZshShellReadyRcfileContent()
  const zshLogin = `# Orca daemon zsh shell-ready wrapper
_orca_home="\${ORCA_ORIG_ZDOTDIR:-$HOME}"
case "\${_orca_home%/}" in
  */shell-ready/zsh) _orca_home="$HOME" ;;
esac
if [[ -o interactive && -f "$_orca_home/.zlogin" ]]; then
  source "$_orca_home/.zlogin"
fi
__orca_restore_attribution_path() {
  [[ -n "\${ORCA_ATTRIBUTION_SHIM_DIR:-}" ]] || return 0
  case "$PATH" in
    "\${ORCA_ATTRIBUTION_SHIM_DIR}"|"\${ORCA_ATTRIBUTION_SHIM_DIR}:"*) return 0 ;;
  esac
  export PATH="\${ORCA_ATTRIBUTION_SHIM_DIR}:$PATH"
}
__orca_restore_attribution_path
# Why: .zlogin is the final login startup file before the prompt is shown.
[[ -n "\${ORCA_OPENCODE_CONFIG_DIR:-}" ]] && export OPENCODE_CONFIG_DIR="\${ORCA_OPENCODE_CONFIG_DIR}"
[[ -n "\${ORCA_PI_CODING_AGENT_DIR:-}" ]] && export PI_CODING_AGENT_DIR="\${ORCA_PI_CODING_AGENT_DIR}"
if [[ "\${ORCA_SHELL_READY_MARKER:-0}" == "1" ]]; then
  __orca_prompt_mark() {
    printf "${SHELL_READY_MARKER}"
  }
  # Why: zsh precmd fires before zle switches the PTY into line-editing mode,
  # so writing startup input there can be echoed once outside the prompt.
  autoload -Uz add-zle-hook-widget
  zle -N __orca_prompt_mark
  add-zle-hook-widget line-init __orca_prompt_mark
fi
`
  const bashRc = `# Orca daemon bash shell-ready wrapper
[[ -f /etc/profile ]] && source /etc/profile
if [[ -f "$HOME/.bash_profile" ]]; then
  source "$HOME/.bash_profile"
elif [[ -f "$HOME/.bash_login" ]]; then
  source "$HOME/.bash_login"
elif [[ -f "$HOME/.profile" ]]; then
  source "$HOME/.profile"
fi
__orca_restore_attribution_path() {
  [[ -n "\${ORCA_ATTRIBUTION_SHIM_DIR:-}" ]] || return 0
  case "$PATH" in
    "\${ORCA_ATTRIBUTION_SHIM_DIR}"|"\${ORCA_ATTRIBUTION_SHIM_DIR}:"*) return 0 ;;
  esac
  export PATH="\${ORCA_ATTRIBUTION_SHIM_DIR}:$PATH"
}
__orca_restore_attribution_path
# Why: user startup files may set the default OpenCode config after Orca's
# spawn env; restore the PTY-scoped overlay before the first prompt.
[[ -n "\${ORCA_OPENCODE_CONFIG_DIR:-}" ]] && export OPENCODE_CONFIG_DIR="\${ORCA_OPENCODE_CONFIG_DIR}"
# Why: PI_CODING_AGENT_DIR is also a single-root env var users may re-export.
[[ -n "\${ORCA_PI_CODING_AGENT_DIR:-}" ]] && export PI_CODING_AGENT_DIR="\${ORCA_PI_CODING_AGENT_DIR}"
if [[ "\${ORCA_SHELL_READY_MARKER:-0}" == "1" ]]; then
  __orca_prompt_mark() {
    printf "${SHELL_READY_MARKER}"
  }
  if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
    PROMPT_COMMAND=("\${PROMPT_COMMAND[@]}" "__orca_prompt_mark")
  else
    _orca_prev_prompt_command="\${PROMPT_COMMAND}"
    if [[ -n "\${_orca_prev_prompt_command}" ]]; then
      PROMPT_COMMAND="\${_orca_prev_prompt_command};__orca_prompt_mark"
    else
      PROMPT_COMMAND="__orca_prompt_mark"
    fi
  fi
fi
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
    writeFileSync(path, content, 'utf8')
    chmodSync(path, 0o644)
  }
}

export function resolvePtyShellPath(env: Record<string, string>): string {
  if (process.platform === 'win32') {
    return env.ORCA_TERMINAL_WINDOWS_SHELL || 'powershell.exe'
  }
  return env.SHELL || process.env.SHELL || '/bin/zsh'
}

export function supportsPtyStartupBarrier(env: Record<string, string>): boolean {
  if (process.platform === 'win32') {
    return false
  }
  const resolvedShell = resolvePtyShellPath(env)
  const shellName = pathWin32.basename(basename(resolvedShell)).toLowerCase()
  return shellName === 'zsh' || shellName === 'bash'
}

type ShellLaunchConfig = {
  args: string[] | null
  env: Record<string, string>
  supportsReadyMarker: boolean
}

function getWrappedShellLaunchConfig(
  shellPath: string,
  options: { emitReadyMarker: boolean }
): ShellLaunchConfig {
  const shellName = pathWin32.basename(basename(shellPath)).toLowerCase()

  if (shellName === 'zsh') {
    ensureShellReadyWrappers()
    const root = getShellReadyWrapperRoot()
    return {
      args: ['-l'],
      env: {
        ORCA_ORIG_ZDOTDIR: resolveOriginalZdotdir(),
        ZDOTDIR: join(root, 'zsh'),
        ORCA_SHELL_READY_MARKER: options.emitReadyMarker ? '1' : '0'
      },
      supportsReadyMarker: options.emitReadyMarker
    }
  }

  if (shellName === 'bash') {
    ensureShellReadyWrappers()
    const root = getShellReadyWrapperRoot()
    return {
      args: ['--rcfile', join(root, 'bash', 'rcfile')],
      env: {
        ORCA_SHELL_READY_MARKER: options.emitReadyMarker ? '1' : '0'
      },
      supportsReadyMarker: options.emitReadyMarker
    }
  }

  if (isPowerShellExecutableName(shellName)) {
    return {
      args: [
        '-NoLogo',
        '-NoExit',
        '-EncodedCommand',
        encodePowerShellCommand(getPowerShellOsc133Bootstrap())
      ],
      env: {},
      supportsReadyMarker: false
    }
  }

  return {
    args: null,
    env: {},
    supportsReadyMarker: false
  }
}

export function getShellReadyLaunchConfig(shellPath: string): ShellLaunchConfig {
  return getWrappedShellLaunchConfig(shellPath, { emitReadyMarker: true })
}

export function getAttributionShellLaunchConfig(shellPath: string): ShellLaunchConfig {
  return getWrappedShellLaunchConfig(shellPath, { emitReadyMarker: false })
}
