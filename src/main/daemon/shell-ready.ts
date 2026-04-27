import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'fs'

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
function resolveOriginalZdotdir(): string {
  const inherited = process.env.ZDOTDIR
  if (!inherited) {
    return process.env.HOME || ''
  }
  // Why: tolerate trailing slashes — some shell startup scripts export
  // `ZDOTDIR="$dir/"`, and without normalization the suffix check would
  // miss the self-loop path and restore the recursion bug. Also collapses
  // a pathological `ZDOTDIR=/` to empty so we fall back to HOME rather than
  // sourcing `/.zshenv` (which is never the user's real config).
  const normalized = inherited.replace(/\/+$/, '')
  if (!normalized || normalized.endsWith('/shell-ready/zsh')) {
    return process.env.HOME || ''
  }
  return inherited
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
export ORCA_ORIG_ZDOTDIR="\${ORCA_ORIG_ZDOTDIR:-$HOME}"
[[ -f "$ORCA_ORIG_ZDOTDIR/.zshenv" ]] && source "$ORCA_ORIG_ZDOTDIR/.zshenv"
export ZDOTDIR=${quotePosixSingle(zshDir)}
`
  const zshProfile = `# Orca daemon zsh shell-ready wrapper
_orca_home="\${ORCA_ORIG_ZDOTDIR:-$HOME}"
[[ -f "$_orca_home/.zprofile" ]] && source "$_orca_home/.zprofile"
`
  const zshRc = `# Orca daemon zsh shell-ready wrapper
_orca_home="\${ORCA_ORIG_ZDOTDIR:-$HOME}"
if [[ -o interactive && -f "$_orca_home/.zshrc" ]]; then
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
`
  const zshLogin = `# Orca daemon zsh shell-ready wrapper
_orca_home="\${ORCA_ORIG_ZDOTDIR:-$HOME}"
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
if [[ "\${ORCA_SHELL_READY_MARKER:-0}" == "1" ]]; then
  __orca_prompt_mark() {
    printf "${SHELL_READY_MARKER}"
  }
  precmd_functions=(\${precmd_functions[@]} __orca_prompt_mark)
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
    return env.COMSPEC || 'powershell.exe'
  }
  return env.SHELL || process.env.SHELL || '/bin/zsh'
}

export function supportsPtyStartupBarrier(env: Record<string, string>): boolean {
  if (process.platform === 'win32') {
    return false
  }
  const shellName = basename(resolvePtyShellPath(env)).toLowerCase()
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
  const shellName = basename(shellPath).toLowerCase()

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
