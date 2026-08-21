import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getPosixOmpShellWrapper } from '../main/pty/omp-shell-wrapper'
import {
  BASH_FEATURE_CHANNEL_BLOCK,
  BASH_PROMPT_COMMAND_COMPOSITION_BLOCK,
  SHELL_STARTUP_IDENTITY_MARKER_BLOCK,
  BASH_HISTFILE_RESTORE_BLOCK,
  ZSH_WRAPPER_DIR_MARKER_CONTENT,
  ZSH_WRAPPER_DIR_MARKER_FILE
} from '../main/shell-templates'
import { writeShellWrapperFiles } from '../main/shell-wrapper-file-writer'
import { buildZshStartupHook, type ZshStartupHookSpec } from '../main/zsh-startup-wrapper-builder'

/** Writes the zsh/bash overlay wrapper files a relay-spawned shell sources.
 *  Split from pty-shell-launch.ts so the launch-config decisions stay readable
 *  next to each other rather than buried under ~150 lines of shell templates. */

const SHELL_READY_MARKER_ESCAPED = '\\033]777;mcode-shell-ready\\007'

// Why the relay no longer needs its own ZDOTDIR shape: it used to republish the
// inherited value as MCODE_USER_ZDOTDIR so the later wrapper files could prefer
// it over the spawn-time MCODE_ORIG_ZDOTDIR. There are no later wrapper files
// now, and ZDOTDIR itself carries the answer, so the relay and desktop bodies
// are one template again.
function getRelayZshWrapperSpec(): ZshStartupHookSpec {
  return {
    headerLabel: 'MCode relay zsh overlay wrapper',
    readyMarkerEscaped: SHELL_READY_MARKER_ESCAPED,
    osc133CommandMarkers: false,
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

  const zshenv = buildZshStartupHook(getRelayZshWrapperSpec())
  const bashRc = `# MCode relay bash overlay wrapper
${BASH_FEATURE_CHANNEL_BLOCK}
${SHELL_STARTUP_IDENTITY_MARKER_BLOCK}
# Why a plain variable: the channel is consumed and destroyed in these first
# lines, so nothing this shell later spawns can see or inherit the selection.
__mcode_ready_marker=""
__mcode_has_feature ready && __mcode_ready_marker=1
unset _mcode_shell_features
unset -f __mcode_has_feature
[[ -f /etc/profile ]] && source /etc/profile
if [[ -f "$HOME/.bash_profile" ]]; then
  source "$HOME/.bash_profile"
elif [[ -f "$HOME/.bash_login" ]]; then
  source "$HOME/.bash_login"
elif [[ -f "$HOME/.profile" ]]; then
  source "$HOME/.profile"
fi
# Why: enable bracketed paste so MCode can deliver a multiline startup prompt as
# a single literal paste (ESC[200~…ESC[201~); without it, older readline builds
# treat each embedded newline as Enter and mangle the prompt into PS2
# continuation. Modern readline defaults this on; force it for the rest.
[[ $- == *i* ]] && bind 'set enable-bracketed-paste on' 2>/dev/null
# Why: remote startup files can re-export user defaults after relay spawn.
[[ -n "\${MCODE_OPENCODE_CONFIG_DIR:-}" ]] && export OPENCODE_CONFIG_DIR="\${MCODE_OPENCODE_CONFIG_DIR}"
[[ -n "\${MCODE_MIMOCODE_HOME:-}" ]] && export MIMOCODE_HOME="\${MCODE_MIMOCODE_HOME}"
[[ -n "\${MCODE_REMOTE_CLI_BIN_DIR:-}" ]] && case ":$PATH:" in *:"\${MCODE_REMOTE_CLI_BIN_DIR}":*) ;; *) export PATH="\${MCODE_REMOTE_CLI_BIN_DIR}:$PATH" ;; esac
${getPosixOmpShellWrapper()}
${BASH_HISTFILE_RESTORE_BLOCK}
# Why: SSH bash sessions need the same command lifecycle markers as local
# bash so agent rows stop showing "working" when the foreground command exits.
__mcode_initializing_wrapper=1
__mcode_osc133_precmd() {
  local exit_code=$?
  __mcode_in_prompt_command=1
  if [[ -n "\${__mcode_in_command:-}" ]]; then
    printf "\\033]133;D;%s\\007" "$exit_code"
    unset __mcode_in_command
  fi
  printf "\\033]133;A\\007"
  return "$exit_code"
}
__mcode_osc133_prompt_done() {
  unset __mcode_in_prompt_command; __mcode_adopt_outer_debug_trap
  trap '__mcode_osc133_preexec' DEBUG
}
__mcode_osc133_preexec() {
  if [[ -n "\${__mcode_prompt_status_capture_command:-}" && "$BASH_COMMAND" == "$__mcode_prompt_status_capture_command" ]]; then
    unset __mcode_initial_prompt
    __mcode_in_legacy_prompt_wrapper=1
    return 0
  fi
  if [[ -n "\${__mcode_initializing_wrapper:-}\${__mcode_in_debug_capture:-}\${__mcode_initial_prompt:-}\${__mcode_in_prompt_dispatch:-}\${__mcode_in_legacy_prompt_wrapper:-}\${__mcode_in_prompt_command:-}" ]]; then
    [[ -z "\${__mcode_initializing_wrapper:-}\${__mcode_in_debug_capture:-}" ]] || return 0
    if [[ -n "\${__mcode_initial_prompt:-}" && "$BASH_COMMAND" == "__mcode_osc133_precmd" ]]; then
      unset __mcode_initial_prompt; return 0
    fi
    if [[ -n "\${__mcode_in_prompt_dispatch:-}" ]]; then
      [[ -n "\${__mcode_dispatching_user_prompt_command:-}" ]] || return 0
      if [[ "\${FUNCNAME[1]:-}" == "__mcode_run_prompt_command_array" ]]; then
        case "$BASH_COMMAND" in
          '(( __mcode_exit_code == 0 ))'|'__mcode_restore_prompt_status "$__mcode_exit_code"'|'eval "$__mcode_prompt_part"'|'eval "$__mcode_final_prompt_command"'|__mcode_dispatching_user_prompt_command=*|__mcode_osc133_precmd|__mcode_osc133_prompt_done|__mcode_prompt_mark) return 0 ;;
        esac
      fi
    elif [[ "\${FUNCNAME[1]:-}" == "__mcode_run_prompt_command_array" || "$BASH_COMMAND" == "__mcode_run_prompt_command_array" ]]; then
      return 0
    fi
    [[ -z "\${__mcode_in_legacy_prompt_wrapper:-}" || -n "\${__mcode_dispatching_user_prompt_command:-}" ]] || return 0
    if [[ -n "\${__mcode_in_prompt_command:-}" && "$BASH_COMMAND" == "__mcode_in_debug_capture=1" ]]; then
      return 0
    fi
  fi
  case "\${FUNCNAME[1]:-}" in __mcode_osc133_*|__mcode_prompt_mark|__mcode_restore_prompt_status) return 0 ;; esac
  case "$BASH_COMMAND" in __mcode_osc133_precmd|__mcode_osc133_prompt_done|__mcode_prompt_mark) return 0 ;; esac
  __mcode_run_user_debug_trap
  [[ -z "\${__mcode_in_prompt_command:-}" ]] || return 0
  [[ -z "\${__mcode_in_command:-}" ]] || return 0
  printf "\\033]133;C\\007"
  __mcode_in_command=1
}
${BASH_PROMPT_COMMAND_COMPOSITION_BLOCK}
__mcode_prepend_prompt_command "__mcode_osc133_precmd"
# Why: SSH startup commands are renderer-delivered; emit the same internal
# readiness marker as local shells only when that delivery mode asks for it.
if [[ -n "$__mcode_ready_marker" ]]; then
  __mcode_prompt_mark() {
    printf "${SHELL_READY_MARKER_ESCAPED}"
  }
  __mcode_append_prompt_command "__mcode_prompt_mark"
fi
__mcode_append_prompt_command '__mcode_in_debug_capture=1; __mcode_prompt_had_functrace=""; if [[ -o functrace ]]; then __mcode_prompt_had_functrace=1; set +T; fi; __mcode_outer_debug_trap_spec="$(trap -p DEBUG)"; [[ -z "$__mcode_prompt_had_functrace" ]] || set -T; unset __mcode_prompt_had_functrace __mcode_in_debug_capture'
__mcode_append_prompt_command "__mcode_osc133_prompt_done"
__mcode_had_functrace=""
[[ -o functrace ]] && __mcode_had_functrace=1
set +T
__mcode_debug_trap_spec="$(trap -p DEBUG)"
[[ -z "$__mcode_had_functrace" ]] || set -T
if [[ -n "$__mcode_debug_trap_spec" && "$__mcode_debug_trap_spec" != "trap -- '__mcode_osc133_preexec' DEBUG" ]]; then
  __mcode_debug_trap_command="\${__mcode_debug_trap_spec#trap -- }"
  __mcode_debug_trap_command="\${__mcode_debug_trap_command% DEBUG}"
  eval "__mcode_user_debug_trap=$__mcode_debug_trap_command"
fi
unset __mcode_debug_trap_spec __mcode_debug_trap_command __mcode_had_functrace
unset -f __mcode_normalize_prompt_command_part __mcode_normalize_prompt_command __mcode_prepend_prompt_command __mcode_append_prompt_command
unset __mcode_prompt_command_normalized
# Why: arm DEBUG after wrapper setup so the relay rcfile itself does not emit
# fake command-start/end markers before the first prompt.
__mcode_initial_prompt=1
trap '__mcode_osc133_preexec' DEBUG
unset __mcode_initializing_wrapper
`

  // Only .zshenv: see local-pty-shell-ready-wrapper-generation.ts.
  const files = [
    [join(zshDir, '.zshenv'), zshenv],
    [join(zshDir, ZSH_WRAPPER_DIR_MARKER_FILE), ZSH_WRAPPER_DIR_MARKER_CONTENT],
    [join(bashDir, 'rcfile'), bashRc]
  ] as const

  // Why: relay wrapper files persist under ~/.mcode-relay across app upgrades.
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
