/* eslint-disable max-lines -- Why: this module owns both shell wrapper file
   generation and the matching startup-command readiness scanner; splitting
   them would make the wrapper/marker contract harder to audit. */
/**
 * Shell-ready startup command support for local PTYs.
 *
 * Why: when Orca needs to inject a startup command (e.g. issue command runner),
 * it must wait until the shell has fully initialized before writing. This module
 * provides shell wrapper rcfiles that emit an OSC 133;A marker after startup,
 * and a data scanner that detects that marker so the command can be written at
 * the right time.
 */
import { basename } from 'path'
import { mkdirSync, writeFileSync, chmodSync } from 'fs'
import { app } from 'electron'
import type * as pty from 'node-pty'

let didEnsureShellReadyWrappers = false

function quotePosixSingle(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

const STARTUP_COMMAND_READY_MAX_WAIT_MS = 1500
const OSC_133_A = '\x1b]133;A'

// ── OSC 133;A scanner ───────────────────────────────────────────────

export type ShellReadyScanState = {
  matchPos: number
  heldBytes: string
}

export function createShellReadyScanState(): ShellReadyScanState {
  return { matchPos: 0, heldBytes: '' }
}

export function scanForShellReady(
  state: ShellReadyScanState,
  data: string
): { output: string; matched: boolean } {
  let output = ''

  for (let i = 0; i < data.length; i += 1) {
    const ch = data[i] as string
    if (state.matchPos < OSC_133_A.length) {
      if (ch === OSC_133_A[state.matchPos]) {
        state.heldBytes += ch
        state.matchPos += 1
      } else {
        output += state.heldBytes
        state.heldBytes = ''
        state.matchPos = 0
        if (ch === OSC_133_A[0]) {
          state.heldBytes = ch
          state.matchPos = 1
        } else {
          output += ch
        }
      }
    } else if (ch === '\x07') {
      const remaining = data.slice(i + 1)
      state.heldBytes = ''
      state.matchPos = 0
      return { output: output + remaining, matched: true }
    } else {
      state.heldBytes += ch
    }
  }

  return { output, matched: false }
}

// ── Shell wrapper files ─────────────────────────────────────────────

function getShellReadyWrapperRoot(): string {
  return `${app.getPath('userData')}/shell-ready`
}

// Why: if our own process inherited ZDOTDIR from a parent shell that was
// itself an Orca PTY (e.g. the user launched `pn dev` from a terminal inside
// a running Orca), that ZDOTDIR points at an Orca shell-ready wrapper dir.
// Propagating it as the new PTY's ORCA_ORIG_ZDOTDIR makes the wrapper's
// `source "$ORCA_ORIG_ZDOTDIR/.zshenv"` line source itself recursively —
// zsh gives "job table full or recursion limit exceeded" and the shell
// never reaches a usable prompt.
//
// Any path component ending in `/shell-ready/zsh` is an Orca wrapper dir
// (regardless of whether it came from this app's userData, a packaged Orca,
// or a different dev build). Treat it as if ZDOTDIR were unset so the caller
// falls back to HOME for the user's real config root.
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

export function getBashShellReadyRcfileContent(): string {
  return `# Orca bash shell-ready wrapper
[[ -f /etc/profile ]] && source /etc/profile
if [[ -f "$HOME/.bash_profile" ]]; then
  source "$HOME/.bash_profile"
elif [[ -f "$HOME/.bash_login" ]]; then
  source "$HOME/.bash_login"
elif [[ -f "$HOME/.profile" ]]; then
  source "$HOME/.profile"
fi
# Why: preserve bash's normal login-shell contract. Many users already source
# ~/.bashrc from ~/.bash_profile; forcing ~/.bashrc again here would duplicate
# PATH edits, hooks, and prompt init in Orca startup-command shells.
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
# Why: append the marker through PROMPT_COMMAND so it fires after the login
# startup files have rebuilt the prompt, without re-running user rc files.
if [[ "\${ORCA_SHELL_READY_MARKER:-0}" == "1" ]]; then
  __orca_prompt_mark() {
    printf "\\033]133;A\\007"
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
}

function ensureShellReadyWrappers(): void {
  if (didEnsureShellReadyWrappers || process.platform === 'win32') {
    return
  }
  didEnsureShellReadyWrappers = true

  const root = getShellReadyWrapperRoot()
  const zshDir = `${root}/zsh`
  const bashDir = `${root}/bash`

  const zshEnv = `# Orca zsh shell-ready wrapper
export ORCA_ORIG_ZDOTDIR="\${ORCA_ORIG_ZDOTDIR:-$HOME}"
case "\${ORCA_ORIG_ZDOTDIR%/}" in
  */shell-ready/zsh) export ORCA_ORIG_ZDOTDIR="$HOME" ;;
esac
[[ -f "$ORCA_ORIG_ZDOTDIR/.zshenv" ]] && source "$ORCA_ORIG_ZDOTDIR/.zshenv"
export ZDOTDIR=${quotePosixSingle(zshDir)}
`
  const zshProfile = `# Orca zsh shell-ready wrapper
_orca_home="\${ORCA_ORIG_ZDOTDIR:-$HOME}"
case "\${_orca_home%/}" in
  */shell-ready/zsh) _orca_home="$HOME" ;;
esac
[[ -f "$_orca_home/.zprofile" ]] && source "$_orca_home/.zprofile"
`
  const zshRc = `# Orca zsh shell-ready wrapper
_orca_home="\${ORCA_ORIG_ZDOTDIR:-$HOME}"
case "\${_orca_home%/}" in
  */shell-ready/zsh) _orca_home="$HOME" ;;
esac
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
if [[ ! -o login ]]; then
  __orca_restore_attribution_path
  # Why: ~/.zshrc can export the user's default OpenCode config after spawn.
  [[ -n "\${ORCA_OPENCODE_CONFIG_DIR:-}" ]] && export OPENCODE_CONFIG_DIR="\${ORCA_OPENCODE_CONFIG_DIR}"
  # Why: PI_CODING_AGENT_DIR must keep the same PTY-scoped overlay after rc files.
  [[ -n "\${ORCA_PI_CODING_AGENT_DIR:-}" ]] && export PI_CODING_AGENT_DIR="\${ORCA_PI_CODING_AGENT_DIR}"
fi
`
  const zshLogin = `# Orca zsh shell-ready wrapper
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
# Why: zsh precmd runs before the prompt is drawn and before zle owns input,
# which can double-echo startup commands. line-init fires when zle is ready.
if [[ "\${ORCA_SHELL_READY_MARKER:-0}" == "1" ]]; then
  __orca_prompt_mark() {
    printf "\\033]133;A\\007"
  }
  autoload -Uz add-zle-hook-widget
  zle -N __orca_prompt_mark
  add-zle-hook-widget line-init __orca_prompt_mark
fi
`
  const bashRc = getBashShellReadyRcfileContent()

  const files = [
    [`${zshDir}/.zshenv`, zshEnv],
    [`${zshDir}/.zprofile`, zshProfile],
    [`${zshDir}/.zshrc`, zshRc],
    [`${zshDir}/.zlogin`, zshLogin],
    [`${bashDir}/rcfile`, bashRc]
  ] as const

  for (const [path, content] of files) {
    const dir = path.slice(0, path.lastIndexOf('/'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, content, 'utf8')
    chmodSync(path, 0o644)
  }
}

// ── Shell launch config ─────────────────────────────────────────────

export type ShellReadyLaunchConfig = {
  args: string[] | null
  env: Record<string, string>
  supportsReadyMarker: boolean
}

function getWrappedShellLaunchConfig(
  shellPath: string,
  options: { emitReadyMarker: boolean }
): ShellReadyLaunchConfig {
  const shellName = basename(shellPath).toLowerCase()

  if (shellName === 'zsh') {
    ensureShellReadyWrappers()
    return {
      args: ['-l'],
      env: {
        ORCA_ORIG_ZDOTDIR: resolveOriginalZdotdir(),
        ZDOTDIR: `${getShellReadyWrapperRoot()}/zsh`,
        ORCA_SHELL_READY_MARKER: options.emitReadyMarker ? '1' : '0'
      },
      supportsReadyMarker: options.emitReadyMarker
    }
  }

  if (shellName === 'bash') {
    ensureShellReadyWrappers()
    return {
      args: ['--rcfile', `${getShellReadyWrapperRoot()}/bash/rcfile`],
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

export function getShellReadyLaunchConfig(shellPath: string): ShellReadyLaunchConfig {
  return getWrappedShellLaunchConfig(shellPath, { emitReadyMarker: true })
}

export function getAttributionShellLaunchConfig(shellPath: string): ShellReadyLaunchConfig {
  return getWrappedShellLaunchConfig(shellPath, { emitReadyMarker: false })
}

// ── Startup command writer ──────────────────────────────────────────

export function writeStartupCommandWhenShellReady(
  readyPromise: Promise<void>,
  proc: pty.IPty,
  startupCommand: string,
  onExit: (cleanup: () => void) => void
): void {
  let sent = false
  let postReadyTimer: ReturnType<typeof setTimeout> | null = null
  let postReadyDataDisposable: { dispose: () => void } | null = null

  const cleanup = (): void => {
    sent = true
    if (postReadyTimer !== null) {
      clearTimeout(postReadyTimer)
      postReadyTimer = null
    }
    postReadyDataDisposable?.dispose()
    postReadyDataDisposable = null
  }

  const flush = (): void => {
    if (sent) {
      return
    }
    sent = true
    postReadyDataDisposable?.dispose()
    postReadyDataDisposable = null
    if (postReadyTimer !== null) {
      clearTimeout(postReadyTimer)
      postReadyTimer = null
    }
    // Why: run startup commands inside the same interactive shell Orca keeps
    // open for the pane. Spawning `shell -c <command>; exec shell -l` would
    // avoid the race, but it would also replace the session after the agent
    // exits and break "stay in this terminal" workflows.
    // Why CR on Windows: PowerShell's PSReadLine and cmd.exe submit the line
    // on CR (`\r`) — a bare LF leaves the command typed at the prompt but
    // unsubmitted, forcing the user to press Enter after Orca launches the
    // agent or setup script. POSIX shells (bash/zsh) treat either CR or LF as
    // Enter under ICRNL, so CR works there too, but this code path is reached
    // on Windows as well as POSIX via writeStartupCommandWhenShellReady.
    const submit = process.platform === 'win32' ? '\r' : '\n'
    const endsWithSubmit = startupCommand.endsWith('\r') || startupCommand.endsWith('\n')
    const payload = endsWithSubmit ? startupCommand : `${startupCommand}${submit}`
    // Why: startup commands are usually long, quoted agent launches. Writing
    // them in one PTY call after the shell-ready barrier avoids the incremental
    // paste behavior that still dropped characters in practice.
    proc.write(payload)
  }

  readyPromise.then(() => {
    if (sent) {
      return
    }
    // Why: the shell-ready marker (OSC 133;A) fires from precmd/PROMPT_COMMAND,
    // before the prompt is drawn and before zle/readline switches the PTY into
    // raw mode. Writing the command while the kernel still has ECHO enabled
    // causes the characters to be echoed once by the kernel and then redisplayed
    // by the line editor after the prompt — producing a visible duplicate.
    //
    // Strategy: wait for the next PTY data event after the ready marker. That
    // data is the shell drawing its prompt, which means the shell is about to
    // (or has already) switched to raw mode. A brief follow-up delay covers the
    // gap between the last prompt write() and the tcsetattr() that enables raw
    // mode. The 50ms fallback timeout handles the case where the prompt data
    // arrived in the same chunk as the ready marker (no subsequent onData).
    postReadyDataDisposable = proc.onData(() => {
      postReadyDataDisposable?.dispose()
      postReadyDataDisposable = null
      if (postReadyTimer !== null) {
        clearTimeout(postReadyTimer)
      }
      postReadyTimer = setTimeout(flush, 30)
    })
    postReadyTimer = setTimeout(() => {
      postReadyDataDisposable?.dispose()
      postReadyDataDisposable = null
      postReadyTimer = null
      flush()
    }, 50)
  })
  onExit(cleanup)
}

export { STARTUP_COMMAND_READY_MAX_WAIT_MS }
