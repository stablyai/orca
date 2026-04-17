import { tmpdir } from 'os'
import { basename, join } from 'path'
import { chmodSync, mkdirSync, writeFileSync } from 'fs'

const SHELL_READY_WRAPPER_ROOT = join(tmpdir(), 'orca-shell-ready')
const SHELL_READY_MARKER = '\\033]777;orca-shell-ready\\007'

let didEnsureShellReadyWrappers = false

function quotePosixSingle(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function ensureShellReadyWrappers(): void {
  if (didEnsureShellReadyWrappers || process.platform === 'win32') {
    return
  }
  didEnsureShellReadyWrappers = true

  const zshDir = join(SHELL_READY_WRAPPER_ROOT, 'zsh')
  const bashDir = join(SHELL_READY_WRAPPER_ROOT, 'bash')

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
`
  const zshLogin = `# Orca daemon zsh shell-ready wrapper
_orca_home="\${ORCA_ORIG_ZDOTDIR:-$HOME}"
if [[ -o interactive && -f "$_orca_home/.zlogin" ]]; then
  source "$_orca_home/.zlogin"
fi
__orca_prompt_mark() {
  printf "${SHELL_READY_MARKER}"
}
precmd_functions=(\${precmd_functions[@]} __orca_prompt_mark)
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
`

  const files = [
    [join(zshDir, '.zshenv'), zshEnv],
    [join(zshDir, '.zprofile'), zshProfile],
    [join(zshDir, '.zshrc'), zshRc],
    [join(zshDir, '.zlogin'), zshLogin],
    [join(bashDir, 'rcfile'), bashRc]
  ] as const

  for (const [path, content] of files) {
    mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true })
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

export function getShellReadyLaunchConfig(shellPath: string): {
  args: string[] | null
  env: Record<string, string>
  supportsReadyMarker: boolean
} {
  const shellName = basename(shellPath).toLowerCase()

  if (shellName === 'zsh') {
    ensureShellReadyWrappers()
    return {
      args: ['-l'],
      env: {
        ORCA_ORIG_ZDOTDIR: process.env.ZDOTDIR || process.env.HOME || '',
        ZDOTDIR: join(SHELL_READY_WRAPPER_ROOT, 'zsh')
      },
      supportsReadyMarker: true
    }
  }

  if (shellName === 'bash') {
    ensureShellReadyWrappers()
    return {
      args: ['--rcfile', join(SHELL_READY_WRAPPER_ROOT, 'bash', 'rcfile')],
      env: {},
      supportsReadyMarker: true
    }
  }

  return {
    args: null,
    env: {},
    supportsReadyMarker: false
  }
}
