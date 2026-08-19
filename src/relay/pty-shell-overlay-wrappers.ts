import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getPosixOmpShellWrapper } from '../main/pty/omp-shell-wrapper'
import {
  BASH_FEATURE_CHANNEL_BLOCK,
  BASH_PROMPT_COMMAND_COMPOSITION_BLOCK,
  SHELL_STARTUP_IDENTITY_MARKER_BLOCK,
  ZSH_HISTFILE_RESTORE_BLOCK,
  ZSH_WRAPPER_DIR_MARKER_CONTENT,
  ZSH_WRAPPER_DIR_MARKER_FILE
} from '../main/shell-templates'
import { writeShellWrapperFiles } from '../main/shell-wrapper-file-writer'
import {
  buildZshStartupWrapperFiles,
  type ZshStartupWrapperSpec
} from '../main/zsh-startup-wrapper-builder'

/** Writes the zsh/bash overlay wrapper files a relay-spawned shell sources.
 *  Split from pty-shell-launch.ts so the launch-config decisions stay readable
 *  next to each other rather than buried under ~150 lines of shell templates. */

const SHELL_READY_MARKER_ESCAPED = '\\033]777;orca-shell-ready\\007'

// Why: the relay .zshenv republishes the inherited ZDOTDIR as ORCA_USER_ZDOTDIR,
// so later wrapper files prefer it over the spawn-time ORCA_ORIG_ZDOTDIR.
const RELAY_HOME_EXPRESSION = '"${ORCA_USER_ZDOTDIR:-${ORCA_ORIG_ZDOTDIR:-$HOME}}"'

function getRelayZshWrapperSpec(zshDir: string): ZshStartupWrapperSpec {
  return {
    headerLabel: 'Orca relay zsh overlay wrapper',
    zshDir,
    zshenvStrategy: 'overlay-user-zdotdir',
    homeExpression: RELAY_HOME_EXPRESSION,
    readyMarkerEscaped: SHELL_READY_MARKER_ESCAPED,
    osc133CommandMarkers: false,
    skipUserZshrcWhenHomeIsWrapperDir: false,
    overlayRestoreComment:
      '# Why: remote startup files can re-export user defaults after relay spawn.',
    restores: {
      agentTeamsPath: false,
      remoteCliBinDir: true,
      codexHome: false,
      codexLaunchPreflight: false
    }
  }
}

/** True when every overlay wrapper file is present and non-empty afterwards. */
export function ensureOverlayRestoreWrappers(root: string): boolean {
  const zshDir = join(root, 'zsh')
  const bashDir = join(root, 'bash')

  const zsh = buildZshStartupWrapperFiles(getRelayZshWrapperSpec(zshDir))
  const bashRc = `# Orca relay bash overlay wrapper
${BASH_FEATURE_CHANNEL_BLOCK}
${SHELL_STARTUP_IDENTITY_MARKER_BLOCK}
# Why a plain variable: the channel is consumed and destroyed in these first
# lines, so nothing this shell later spawns can see or inherit the selection.
__orca_ready_marker=""
__orca_has_feature ready && __orca_ready_marker=1
unset _orca_shell_features
unset -f __orca_has_feature
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
${ZSH_HISTFILE_RESTORE_BLOCK}
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
if [[ -n "$__orca_ready_marker" ]]; then
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
    [join(zshDir, '.zshenv'), zsh.zshenv],
    [join(zshDir, '.zprofile'), zsh.zprofile],
    [join(zshDir, '.zshrc'), zsh.zshrc],
    [join(zshDir, '.zlogin'), zsh.zlogin],
    [join(zshDir, ZSH_WRAPPER_DIR_MARKER_FILE), ZSH_WRAPPER_DIR_MARKER_CONTENT],
    [join(bashDir, 'rcfile'), bashRc]
  ] as const

  // Why: relay wrapper files persist under ~/.orca-relay across app upgrades.
  // Existence alone is not enough; stale wrappers would miss later fixes such
  // as preserving post-.zshenv ZDOTDIR.
  const stale = files.filter(([path, content]) => readFileOrNull(path) !== content)
  if (stale.length > 0 && !writeShellWrapperFiles(stale, '[relay/shell-overlay]')) {
    return false
  }
  return files.every(([path]) => isNonEmptyFile(path))
}

function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function isNonEmptyFile(path: string): boolean {
  try {
    return statSync(path).size > 0
  } catch {
    return false
  }
}
