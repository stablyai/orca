// Why: local PTYs and the daemon/SSH path must use identical ZDOTDIR discovery;
// small drift here breaks different terminal transports in different ways.
import { SHELL_STARTUP_FEATURE_ENV } from './shell-startup-features'

function quotePosixSingle(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

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
export const ZSH_FEATURE_CHANNEL_BLOCK = `typeset -ga _orca_shell_features
_orca_shell_features=(\${(s:,:)\${${SHELL_STARTUP_FEATURE_ENV}:-}})
builtin unset ${SHELL_STARTUP_FEATURE_ENV}
__orca_has_feature() { (( \${_orca_shell_features[(Ie)$1]} )) }`

/** The bash rcfile equivalent of ZSH_FEATURE_CHANNEL_BLOCK. */
export const BASH_FEATURE_CHANNEL_BLOCK = `_orca_shell_features=",\${${SHELL_STARTUP_FEATURE_ENV}:-},"
builtin unset ${SHELL_STARTUP_FEATURE_ENV}
__orca_has_feature() { [[ "$_orca_shell_features" == *",$1,"* ]]; }`

// Why one line usable by both languages: __orca_has_feature is defined with the
// same name and semantics in the zsh and bash channel blocks above.
export const SHELL_STARTUP_IDENTITY_MARKER_BLOCK = `__orca_has_feature identity && printf "\\033]777;orca-shell-start:%s\\007" "$$"`

/**
 * Resolves the directory Orca should treat as the user's zsh config root.
 *
 * Why positive identification: Orca may only reject a config dir it can prove is
 * its own. A stamped marker file (or Orca's own wrapper path shape, for
 * wrappers written by older builds) is that proof. Guessing at other
 * terminals' wrapper dirs by name never can be, so this never tries.
 *
 * Why every generated file redefines it instead of relying on .zshenv: one
 * wrapper dir can be rewritten by two concurrently installed builds, so a shell
 * can read one build's .zshenv and another's .zshrc. A .zshrc that called a
 * function only the newer .zshenv defines printed `command not found` AND left
 * the out-parameter empty, which skipped sourcing the user's own startup file.
 *
 * Why an Orca-private out-parameter and not `REPLY`: `REPLY` is zsh's shared
 * scratch global, so a user config is entitled to constrain it. `typeset -r
 * REPLY` made the very first assignment a fatal error and aborted the wrapper
 * file; `typeset -i REPLY` silently turned every resolved path into `0`. Both
 * left HISTFILE inside Orca's wrapper dir. Harmless while Orca wrapped a few
 * percent of panes; not harmless now that it wraps every zsh pane.
 *
 * Why `typeset -g`: .zshrc/.zlogin call this AFTER the user's own config, so
 * creating a plain global inside a function would print a warning per call
 * under `setopt warn_create_global`.
 */
export const ZSH_USER_CONFIG_DIR_RESOLVER_BLOCK = `__orca_resolve_user_config_dir() {
  typeset -g _orca_resolved_config_dir="\${1:-}"
  while [[ "$_orca_resolved_config_dir" == */ ]]; do _orca_resolved_config_dir="\${_orca_resolved_config_dir%/}"; done
  if [[ -z "$_orca_resolved_config_dir" || -f "$_orca_resolved_config_dir/${ZSH_WRAPPER_DIR_MARKER_FILE}" || "$_orca_resolved_config_dir" == */shell-ready/zsh ]]; then
    _orca_resolved_config_dir="$HOME"
  fi
}`

/**
 * The stricter resolver .zshenv uses for a ZDOTDIR this shell INHERITED.
 *
 * Why only .zshenv needs it: nothing after .zshenv re-reads an inherited value —
 * the later files resolve ORCA_ORIG_ZDOTDIR, which .zshenv already vetted.
 */
export const ZSH_INHERITED_CONFIG_DIR_RESOLVER_BLOCK = `# Why stricter for an inherited value: Orca can be launched from a terminal that
# already pointed ZDOTDIR at its own wrapper dir, and a directory holding no zsh
# startup file at all is not the user's config root whoever wrote it.
__orca_resolve_inherited_config_dir() {
  __orca_resolve_user_config_dir "\${1:-}"
  [[ "$_orca_resolved_config_dir" == "$HOME" ]] && return 0
  local _orca_startup_file
  for _orca_startup_file in .zshenv .zshrc .zprofile .zlogin; do
    [[ -r "$_orca_resolved_config_dir/$_orca_startup_file" ]] && return 0
  done
  _orca_resolved_config_dir="$HOME"
}`

// Why: daemon, local, and relay wrappers must preserve one Bash prompt-hook contract.
export { BASH_PROMPT_COMMAND_COMPOSITION_BLOCK } from './bash-prompt-command-composition'

/**
 * Fork-free precondition for the `$(emulate)` probe: options that both
 * `emulate sh` and `emulate ksh` turn on, so all-off proves zsh emulation.
 *
 * Why: the probe is a command substitution, which forks a zsh carrying every
 * function, alias and completion the user's config has loaded by that point —
 * the most expensive line in the wrapper, and one every zsh pane pays now that
 * wrapping widened to all of them. Measured on zsh 5.9 / macOS, 150 login
 * startups per arm, with a user .zshenv + .zprofile + .zshrc present: 9.97
 * ms/run unwrapped, 14.20 ms/run wrapped, 12.27 ms/run wrapped once these three
 * probes are skipped — about half of what wrapping costs.
 *
 * Why a hint in front of the real probe and not a replacement for it: these
 * options say nothing about `emulation`, which is what zsh's `sourcehome()`
 * branches on, so a config that sets one by hand must still get the exact
 * answer. OR, not AND, so the only way past it is to enter emulation and then
 * unset all three; every real `emulate sh`/`emulate ksh` sets them. A false
 * positive costs exactly the fork this saves.
 *
 * Why `2>/dev/null`: `[[ -o <unknown> ]]` prints `no such option` to stderr and
 * returns false rather than aborting, so on a zsh too old for one of these
 * names the only symptom would be that text in the user's pane. All three
 * predate every zsh Orca supports, so this is belt and braces, not a fallback.
 */
export const ZSH_BOURNE_EMULATION_OPTION_HINT =
  '[[ -o ksharrays || -o shwordsplit || -o shglob ]] 2>/dev/null'

/**
 * Hands the pane back to the user unwrapped when zsh has entered sh/ksh
 * emulation, and stops reading the rest of the current wrapper file.
 *
 * Why: zsh's `sourcehome()` ignores ZDOTDIR entirely once the shell is in sh or
 * ksh emulation, so a user .zshenv (or .zprofile) ending in `emulate sh` means
 * NO later wrapper file is ever read — the epilogue runs zero times, while the
 * user's own $HOME startup files load normally. The pane looks fine and writes
 * its history inside Orca's wrapper dir, where the user will never find it.
 *
 * Nothing can repair that from here (`/etc/zshrc` assigns HISTFILE after
 * .zshenv and .zprofile both), so the wrapper does the next best thing: it
 * restores the user's own ZDOTDIR and consumes Orca's variables, leaving
 * exactly the shell an unwrapped pane would have produced. Degrading to the
 * pre-wrapping behaviour is the bar; degrading to something worse is not.
 *
 * Why a positive `sh|ksh` match rather than `!= zsh`: a zsh too old for the
 * query form of `emulate` prints nothing, and must not unwrap every pane.
 *
 * Why `sourcedUserFileTest` gates the probe rather than it running
 * unconditionally: `$(emulate)` forks, and every zsh pane now pays for it. The
 * gate loses no coverage — this wrapper file is itself read through ZDOTDIR, so
 * anything that had already entered emulation (a system /etc/zshenv or
 * /etc/zprofile) would have hidden this very file too. The only thing that can
 * have entered emulation by this line is the user file this file just sourced.
 *
 * Why ZSH_BOURNE_EMULATION_OPTION_HINT gates it further: see that constant.
 */
export function getZshEmulationDegradeBlock(options: {
  userZdotdirExpression: string
  sourcedUserFileTest: string
}): string {
  return `if [[ ${options.sourcedUserFileTest} ]] && ${ZSH_BOURNE_EMULATION_OPTION_HINT}; then
  case "$(emulate 2>/dev/null)" in
    sh|ksh)
      export ZDOTDIR=${options.userZdotdirExpression}
      # Why unset: an ORCA_HISTFILE no wrapper file will ever consume is
      # inherited by everything this pane spawns, including a nested Orca.
      builtin unset ORCA_HISTFILE _orca_shell_features _orca_home _orca_resolved_config_dir _orca_wrapper_zdotdir_self
      unfunction __orca_shell_epilogue __orca_has_feature __orca_resolve_user_config_dir __orca_resolve_inherited_config_dir 2>/dev/null
      return 0
      ;;
  esac
fi`
}

/** The ZDOTDIR-discovery body of the wrapper .zshenv (no header, no epilogue). */
export function getZshEnvDiscoveryBody(zshDir: string): string {
  return `# Why: capture the runtime wrapper dir before it is unset below. On WSL this
# file is generated with a Windows path but sourced via /mnt/c, so the baked
# literal is unusable there and ZDOTDIR must be restored from this value.
# Derive it from the file being sourced (%x, zsh's internal script name) rather
# than the env-imported $ZDOTDIR: zsh corrupts environment values whose UTF-8
# bytes fall in its 0x84-0x9D token range (e.g. a non-ASCII Windows username
# such as a Korean login), which would make the self-check below fail and fall
# back to the unusable baked literal, so the user's .zshrc never loads (#8003).
# %x is not subject to that corruption; keep $ZDOTDIR as a fallback for the
# rare shell where %x prompt expansion yields nothing.
_orca_wrapper_zdotdir_self="\${\${(%):-%x}:h}"
if [[ -z "\${_orca_wrapper_zdotdir_self:-}" ]]; then
  _orca_wrapper_zdotdir_self="\${ZDOTDIR:-}"
fi
while [[ "\${_orca_wrapper_zdotdir_self:-}" == */ ]]; do
  _orca_wrapper_zdotdir_self="\${_orca_wrapper_zdotdir_self%/}"
done
_orca_zshenv_path=""

# Normalize fallback and source roots before reading user .zshenv so nested
# Orca PTYs never source another Orca wrapper recursively.
__orca_resolve_inherited_config_dir "\${ORCA_ORIG_ZDOTDIR:-$HOME}"
_orca_user_zdotdir="$_orca_resolved_config_dir"
__orca_resolve_inherited_config_dir "\${ORCA_ZSHENV_SOURCE_DIR:-$HOME}"
_orca_zshenv_source_dir="$_orca_resolved_config_dir"
unset ORCA_ZSHENV_SOURCE_DIR

# Why: source at wrapper top level, not in a function/subshell, so .zshenv
# exports, functions, path/fpath typesets, and zsh options keep normal scope.
unset ZDOTDIR
if [[ -n "\${_orca_zshenv_source_dir:-}" && -f "\${_orca_zshenv_source_dir}/.zshenv" ]]; then
  _orca_zshenv_path="\${_orca_zshenv_source_dir}/.zshenv"
fi
if [[ -n "\${_orca_zshenv_path:-}" ]]; then
  source "\${_orca_zshenv_path}"
fi

_orca_discovered_zdotdir="\${ZDOTDIR:-}"

while [[ "\${_orca_discovered_zdotdir}" == */ ]]; do
  _orca_discovered_zdotdir="\${_orca_discovered_zdotdir%/}"
done

case "\${_orca_discovered_zdotdir}" in
  *[![:space:]]*) ;;
  *) _orca_discovered_zdotdir="" ;;
esac

if [[ -n "\${_orca_discovered_zdotdir}" && ! -d "\${_orca_discovered_zdotdir}" ]]; then
  [[ "\${ORCA_DEBUG:-0}" == "1" ]] && echo "[orca-shell-ready] Discovered ZDOTDIR '\${_orca_discovered_zdotdir}' does not exist, falling back" >&2
  _orca_discovered_zdotdir=""
fi

# Why only the ownership check here: a ZDOTDIR the user's own .zshenv just
# exported is the user's by construction, whatever it happens to contain.
__orca_resolve_user_config_dir "\${_orca_discovered_zdotdir:-\${_orca_user_zdotdir:-$HOME}}"
export ORCA_ORIG_ZDOTDIR="$_orca_resolved_config_dir"
unset _orca_user_zdotdir _orca_zshenv_source_dir _orca_discovered_zdotdir

${getZshEmulationDegradeBlock({
  userZdotdirExpression: '"$ORCA_ORIG_ZDOTDIR"',
  sourcedUserFileTest: '-n "${_orca_zshenv_path:-}"'
})}
unset _orca_zshenv_path

# Why: use :- after user .zshenv — a pathological unset under set -u must not
# abort the wrapper; empty falls through to the baked-literal branch.
if [[ -n "\${_orca_wrapper_zdotdir_self:-}" && -f "\${_orca_wrapper_zdotdir_self:-}/.zshenv" ]]; then
  export ZDOTDIR="\${_orca_wrapper_zdotdir_self:-}"
else
  export ZDOTDIR=${quotePosixSingle(zshDir)}
fi
unset _orca_wrapper_zdotdir_self
`
}

/**
 * The relay variant of the discovery body: it trusts the ZDOTDIR the remote
 * shell already inherited instead of re-deriving one, and republishes it as
 * ORCA_USER_ZDOTDIR for the later wrapper files.
 *
 * Why separate: this diverged from the discovery template before unification
 * and is preserved here — reconciling the two is a follow-up.
 */
export function getZshOverlayEnvBody(zshDir: string): string {
  return `__orca_resolve_inherited_config_dir "\${ORCA_ORIG_ZDOTDIR:-$HOME}"
export ORCA_ORIG_ZDOTDIR="$_orca_resolved_config_dir"
[[ -f "$ORCA_ORIG_ZDOTDIR/.zshenv" ]] && source "$ORCA_ORIG_ZDOTDIR/.zshenv"
__orca_resolve_user_config_dir "\${ZDOTDIR:-\${ORCA_ORIG_ZDOTDIR:-$HOME}}"
export ORCA_USER_ZDOTDIR="$_orca_resolved_config_dir"

${getZshEmulationDegradeBlock({
  userZdotdirExpression: '"$ORCA_USER_ZDOTDIR"',
  sourcedUserFileTest: '-f "$ORCA_ORIG_ZDOTDIR/.zshenv"'
})}

export ZDOTDIR=${quotePosixSingle(zshDir)}
`
}

/**
 * Restores the worktree-scoped HISTFILE that macOS `/etc/zshrc` destroys.
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
export const ZSH_HISTFILE_RESTORE_BLOCK = `if [[ -n "\${ORCA_HISTFILE:-}" ]]; then
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

export function getZshStartupFileSourceBlock(options: {
  fileName: '.zprofile' | '.zshrc' | '.zlogin'
  homeExpression?: string
  interactiveOnly?: boolean
  skipWhenHomeIsCurrentZdotdir?: boolean
}): string {
  const homeExpression = options.homeExpression ?? '"${ORCA_ORIG_ZDOTDIR:-$HOME}"'
  const checks = [
    options.skipWhenHomeIsCurrentZdotdir ? '"$_orca_home" != "$ZDOTDIR"' : null,
    options.interactiveOnly ? '-o interactive' : null,
    `-f "$_orca_home/${options.fileName}"`
  ].filter(Boolean)

  return `__orca_resolve_user_config_dir ${homeExpression}
_orca_home="$_orca_resolved_config_dir"
if [[ ${checks.join(' && ')} ]]; then
  _orca_wrapper_zdotdir="$ZDOTDIR"
  # Why: user startup files resolve plugin/config paths from their own ZDOTDIR;
  # Orca restores its wrapper dir afterward so zsh still loads wrapper files.
  export ZDOTDIR="$_orca_home"
  source "$_orca_home/${options.fileName}"
  export ZDOTDIR="$_orca_wrapper_zdotdir"
  unset _orca_wrapper_zdotdir
fi
`
}

// Why: zsh precmd fires before zle switches the PTY into line-editing mode,
// so the marker must be emitted from zle-line-init. Registering it through
// add-zle-hook-widget is unsafe: the azhw dispatcher aborts its hook chain
// when an earlier hook exits non-zero, and a pre-existing raw user widget
// (e.g. oh-my-zsh vi-mode without VI_MODE_SET_CURSOR) is preserved as the
// first hook and fails — silently suppressing the marker and stalling every
// startup command on the pre-ready timeout. Instead, own zle-line-init: emit
// the marker first, then chain to whatever widget was installed before.
export function getZshShellReadyMarkerRegistrationBlock(escapedMarker: string): string {
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
  printf "${escapedMarker}"
  # Why: call the prior hook as a plain function, not an aliased widget, so
  # $WIDGET stays zle-line-init for add-zle-hook-widget dispatchers.
  if [[ -n "\${__orca_prev_line_init_fn:-}" ]]; then
    "\${__orca_prev_line_init_fn}" "$@"
  fi
}
zle -N zle-line-init __orca_prompt_mark`
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
export function getFishShellReadyInitCommand(escapedMarker: string): string {
  return `function __orca_shell_ready_marker --on-event fish_prompt
  builtin printf "${escapedMarker}"
  functions -e __orca_shell_ready_marker
end`
}

export function getZshFinalZdotdirRestoreBlock(homeExpression = '"${ORCA_ORIG_ZDOTDIR:-$HOME}"') {
  return `__orca_resolve_user_config_dir ${homeExpression}
# Why: after Orca's last wrapper file has loaded, the interactive shell should
# expose the same ZDOTDIR a normal zsh startup would expose.
export ZDOTDIR="$_orca_resolved_config_dir"
unset _orca_home _orca_resolved_config_dir
`
}
