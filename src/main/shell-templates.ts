// Why: local PTYs and the daemon/SSH path must use identical ZDOTDIR discovery;
// small drift here breaks different terminal transports in different ways.
import { SHELL_STARTUP_FEATURE_ENV } from './shell-startup-features'
import { POSIX_SHELL_STARTUP_COMMAND_ENV } from './pty/posix-shell-startup-command'

/** Basename of the file every Orca-generated zsh wrapper dir is stamped with. */
export const ZSH_WRAPPER_DIR_MARKER_FILE = '.orca-shell-wrapper'

export const ZSH_WRAPPER_DIR_MARKER_CONTENT = `# Orca-generated zsh startup wrapper directory.
# Its presence is how Orca recognises its own wrapper dir instead of treating it
# as the user's ZDOTDIR. Do not edit; the whole directory is regenerated.
`

/**
 * The first executable lines of every zsh wrapper: read the feature allowlist,
 * then destroy the variable.
 *
 * Why destroy it here: `_orca_shell_features` is a plain (non-exported) shell
 * variable, so it survives .zshenv -> .zprofile -> .zshrc -> .zlogin in this
 * process but physically cannot reach a child. Unsetting before the user's own
 * .zshenv is sourced means nothing the user's config spawns can see or inherit
 * Orca's feature selection.
 */
export const ZSH_FEATURE_CHANNEL_BLOCK = `builtin typeset -ga _orca_shell_features
_orca_shell_features=(\${(s:,:)\${${SHELL_STARTUP_FEATURE_ENV}:-}})
builtin unset ${SHELL_STARTUP_FEATURE_ENV}
# Why ORCA_HISTFILE is consumed HERE and not in the deferred hook: a user config
# that replaces precmd_functions wholesale drops the hook, and an exported value
# nothing will ever consume is then inherited by every child of this pane,
# including a nested Orca (#11146). Captured non-exported, it cannot escape.
builtin typeset -g _orca_histfile="\${ORCA_HISTFILE:-}"
builtin unset ORCA_HISTFILE
__orca_has_feature() { (( \${_orca_shell_features[(Ie)$1]} )) }`

/** The bash rcfile equivalent of ZSH_FEATURE_CHANNEL_BLOCK. */
export const BASH_FEATURE_CHANNEL_BLOCK = `_orca_shell_features=",\${${SHELL_STARTUP_FEATURE_ENV}:-},"
builtin unset ${SHELL_STARTUP_FEATURE_ENV}
__orca_has_feature() { [[ "$_orca_shell_features" == *",$1,"* ]]; }`

// Why one line usable by both languages: __orca_has_feature is defined with the
// same name and semantics in the zsh and bash channel blocks above.
export const SHELL_STARTUP_IDENTITY_MARKER_BLOCK = `__orca_has_feature identity && printf "\\033]777;orca-shell-start:%s\\007" "$$"`

/**
 * The first executable lines of the wrapper: give ZDOTDIR back to the user.
 *
 * Why before anything else: every later startup file — the user's .zprofile,
 * the system /etc/zshrc, .zshrc, .zlogin — is found through ZDOTDIR. Handing it
 * back here means zsh reads all of them from the user's own directory, exactly
 * as it would with no wrapper at all. In particular /etc/zshrc's unguarded
 * `HISTFILE=${ZDOTDIR:-$HOME}/.zsh_history` then derives the user's own path
 * instead of one inside Orca's wrapper dir, so #11044 cannot happen rather than
 * having to be repaired afterwards.
 *
 * ORCA_ORIG_ZDOTDIR is consumed: it has done its job, and leaving it exported
 * would hand a stale value to everything this pane launches.
 *
 * Why the value is vetted rather than trusted: the launch config only sets this
 * when it resolved a usable dir, but a pane also inherits its parent's
 * environment, so a stale ORCA_ORIG_ZDOTDIR written by an older build can arrive
 * on its own. Handing that back would point ZDOTDIR at an Orca wrapper dir — the
 * self-loop the Node-side ownership check exists to prevent, arriving by a route
 * that check never sees. Identification stays positive, as it is in Node: a
 * stamped marker file, or Orca's own path shape for wrappers older builds wrote.
 */
export const ZSH_ZDOTDIR_HANDBACK_BLOCK = `__orca_usable_zdotdir() {
  [[ -n "\${1:-}" ]] || return 1
  # Orca's own dir, by marker file or by the shape older builds wrote.
  [[ "$1" != */shell-ready/zsh ]] || return 1
  [[ ! -f "$1/${ZSH_WRAPPER_DIR_MARKER_FILE}" ]] || return 1
  # A directory holding no zsh startup file at all is not a config root,
  # whoever wrote it — and a stale value pointing at one would stop zsh from
  # ever reading the user's real .zshenv.
  local _orca_startup_file
  for _orca_startup_file in .zshenv .zshrc .zprofile .zlogin; do
    [[ -r "$1/$_orca_startup_file" ]] && return 0
  done
  return 1
}
if __orca_usable_zdotdir "\${ORCA_ORIG_ZDOTDIR:-}"; then
  builtin export ZDOTDIR="$ORCA_ORIG_ZDOTDIR"
else
  builtin unset ZDOTDIR
fi
builtin unset ORCA_ORIG_ZDOTDIR ORCA_ZSHENV_SOURCE_DIR
builtin unfunction __orca_usable_zdotdir`

/**
 * Sources the user's own .zshenv, then arms the deferred hook.
 *
 * Why `{ } always { }`: the whole compound command is parsed before any of it
 * runs, so the registration below is already parsed as zsh even if the user's
 * .zshenv switches the shell into sh emulation. Sourcing at wrapper top level
 * (not in a function or subshell) keeps the user's exports, functions, fpath
 * typesets and options in their normal scope.
 *
 * Why guarded on absence: the hook is idempotent, but appending it twice would
 * still leave a dead name in the user's precmd_functions.
 */
export const ZSH_USER_ZSHENV_SOURCE_BLOCK = `{
  builtin typeset _orca_user_zshenv="\${ZDOTDIR-$HOME}/.zshenv"
  [[ ! -r "$_orca_user_zshenv" ]] || builtin source -- "$_orca_user_zshenv"
} always {
  builtin unset _orca_user_zshenv
  builtin typeset -ag precmd_functions
  (( \${precmd_functions[(Ie)__orca_deferred_init]} )) || precmd_functions+=(__orca_deferred_init)
}`

// Why: daemon, local, and relay wrappers must preserve one Bash prompt-hook contract.
export { BASH_PROMPT_COMMAND_COMPOSITION_BLOCK } from './bash-prompt-command-composition'

/**
 * Restores the worktree-scoped HISTFILE that macOS `/etc/zshrc` destroys.
 *
 * Bash only. The zsh wrapper no longer needs this: it hands ZDOTDIR back before
 * /etc/zshrc runs, so the value that file derives is already the user's own, and
 * the scoped path is re-applied from a non-exported variable in the deferred
 * hook. The `elif` below is inert under bash, where ZDOTDIR is normally unset.
 *
 * That file assigns `HISTFILE=${ZDOTDIR:-$HOME}/.zsh_history` with no
 * check-before-set, and it runs before any wrapper file Orca controls — so the
 * injected value is already gone, and because ZDOTDIR still points at Orca's
 * wrapper dir the replacement lands INSIDE it. Per-worktree history was a
 * silent no-op on the primary platform as a result (#11044).
 *
 * `builtin unset ORCA_HISTFILE` is the root-cause fix for #11146: the variable
 * cannot be inherited by anything the shell later spawns if it no longer exists
 * once it has been consumed. HISTFILE itself stays exported.
 */
export const BASH_HISTFILE_RESTORE_BLOCK = `if [[ -n "\${ORCA_HISTFILE:-}" ]]; then
  HISTFILE="$ORCA_HISTFILE"
  builtin unset ORCA_HISTFILE
elif [[ "\${HISTFILE:-}" == "$ZDOTDIR/.zsh_history" ]]; then
  # Why also when Orca injected nothing: /etc/zshrc derived this from Orca's
  # wrapper ZDOTDIR, so history would accumulate INSIDE the wrapper dir and the
  # user's real history would be invisible — the plain #11044 bug, with no
  # per-worktree scoping involved. Matching the exact clobbered value means a
  # HISTFILE the user set deliberately is never touched.
  HISTFILE="\${ORCA_ORIG_ZDOTDIR:-$HOME}/.zsh_history"
fi`

// Why: zsh precmd fires before zle switches the PTY into line-editing mode,
// so the marker must be emitted from zle-line-init. Registering it through
// add-zle-hook-widget is unsafe: the azhw dispatcher aborts its hook chain
// when an earlier hook exits non-zero, and a pre-existing raw user widget
// (e.g. oh-my-zsh vi-mode without VI_MODE_SET_CURSOR) is preserved as the
// first hook and fails — silently suppressing the marker and stalling every
// startup command on the pre-ready timeout. Instead, own zle-line-init: emit
// the marker first, then chain to whatever widget was installed before.
export function getZshShellReadyMarkerRegistrationBlock(
  escapedMarker: string,
  supportsStartupCommand = false
): string {
  const markerBlock = supportsStartupCommand
    ? `  if [[ "\${__orca_emit_ready_marker-1}" == 1 ]]; then
    printf "${escapedMarker}"
  fi`
    : `  printf "${escapedMarker}"`
  const startupCommandBlock = supportsStartupCommand
    ? `
  if (( \${+${POSIX_SHELL_STARTUP_COMMAND_ENV}} )); then
    BUFFER="\$${POSIX_SHELL_STARTUP_COMMAND_ENV}"
    CURSOR=\${#BUFFER}
    builtin unset ${POSIX_SHELL_STARTUP_COMMAND_ENV}
    zle accept-line
  fi`
    : ''
  return `# Why: capture the prior zle-line-init so the marker chains to it. On a
# re-source we are already the bound widget, so keep the function captured
# the first time instead of clobbering it to empty (which would silently
# drop the user's widget on every prompt after the second source). Only
# user-defined widgets are chainable as plain functions; builtin/completion
# forms (rare for zle-line-init) are left unchained.
if [[ "\${widgets[zle-line-init]:-}" == "user:__orca_prompt_mark" ]]; then
  :
elif (( \${+widgets[zle-line-init]} )) && [[ "\${widgets[zle-line-init]}" == user:* ]]; then
  __orca_prev_line_init_fn="\${widgets[zle-line-init]#user:}"
else
  __orca_prev_line_init_fn=""
fi
__orca_prompt_mark() {
${markerBlock}
  # Why: call the prior hook as a plain function, not an aliased widget, so
  # $WIDGET stays zle-line-init for add-zle-hook-widget dispatchers.
  if [[ -n "\${__orca_prev_line_init_fn:-}" ]]; then
    "\${__orca_prev_line_init_fn}" "$@"
  fi${startupCommandBlock}
}
zle -N zle-line-init __orca_prompt_mark`.replace(/\n\n}\n$/, '\n}\n')
}

// Why: fish has no ZDOTDIR-style wrapper dir, so the marker rides `--init-command`,
// which fish runs AFTER config.fish (verified on 4.7.1) — the same last-word
// guarantee the zsh/bash wrapper files rely on. It fires on fish_prompt, the
// earliest event fish exposes (STA-3417). Unlike zsh's zle-line-init this lands
// just *before* fish arms `?2004h`, which PostReadyFlushGate absorbs. `builtin
// printf` so a user-defined printf can't silently swallow the marker and send
// every launch to the ready timeout.
//
// Why no feature variable: the init command is composed per pane, so the
// selection is already baked into the text and nothing needs to be exported.
export function getFishShellReadyInitCommand(
  escapedMarker: string,
  emitReadyMarker = true,
  supportsStartupCommand = false
): string {
  const readyMarkerBlock = emitReadyMarker ? `  builtin printf "${escapedMarker}"\n` : ''
  const startupCommandBlock = supportsStartupCommand
    ? `  if set -q ${POSIX_SHELL_STARTUP_COMMAND_ENV}
    set -l __orca_command "\$${POSIX_SHELL_STARTUP_COMMAND_ENV}"
    set -e ${POSIX_SHELL_STARTUP_COMMAND_ENV}
    builtin printf '%s\\n' "$__orca_command"
    eval "$__orca_command"
    return $status
  end\n`
    : ''
  return `function __orca_shell_ready_marker --on-event fish_prompt
${readyMarkerBlock}  functions -e __orca_shell_ready_marker
${startupCommandBlock}end`
}
