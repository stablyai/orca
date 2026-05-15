/**
 * Shared shell wrapper templates for shell-ready PTY initialization.
 *
 * Why: both local PTY (renderer-spawned) and daemon (SSH remote) paths use
 * identical zsh wrapper logic for ZDOTDIR discovery. Centralizing the template
 * prevents divergence and reduces maintenance burden.
 */

function quotePosixSingle(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Generates the zsh .zshenv wrapper content.
 *
 * Why: discovers the user's intended ZDOTDIR (possibly set in ~/.zshenv) by
 * sourcing it in a subshell. This preserves top-level zsh scoping for patterns
 * like "typeset -U path", and isolates early-return / side-effects from our
 * wrapper. For XDG users who set ZDOTDIR in ~/.zshenv, we capture that value;
 * for vanilla users, the subshell yields an empty string and we fall back to
 * HOME. The spawn-env ORCA_ORIG_ZDOTDIR serves as an outer fallback when the
 * current spawn already captured a resolved ZDOTDIR from a previous invocation.
 *
 * @param zshDir - Absolute path to the Orca wrapper directory (will be set as ZDOTDIR)
 * @param headerPrefix - Optional prefix for the header comment (e.g. "daemon")
 */
export function getZshEnvTemplate(zshDir: string, headerPrefix = ''): string {
  const header = headerPrefix
    ? `Orca ${headerPrefix} zsh shell-ready wrapper`
    : 'Orca zsh shell-ready wrapper'
  return `# ${header}
# Why: discover the user's intended ZDOTDIR (possibly set in ~/.zshenv) by
# sourcing it in a subshell. This preserves top-level zsh scoping for patterns
# like "typeset -U path", and isolates early-return / side-effects from our
# wrapper. For XDG users who set ZDOTDIR in ~/.zshenv, we capture that value;
# for vanilla users, the subshell echoes an empty string and we fall back to
# HOME. The spawn-env ORCA_ORIG_ZDOTDIR serves as an outer fallback when the
# current spawn already captured a resolved ZDOTDIR from a previous invocation.
_orca_spawn_orig_zdotdir="\${ORCA_ORIG_ZDOTDIR:-}"
_orca_discovered_zdotdir=$(
  unset ZDOTDIR
  [[ -f "$HOME/.zshenv" ]] && source "$HOME/.zshenv" 2>/dev/null
  printf '%s\\n' "\${ZDOTDIR}"
)
export ORCA_ORIG_ZDOTDIR="\${_orca_discovered_zdotdir:-\${_orca_spawn_orig_zdotdir:-$HOME}}"
# Why: normalize wrapper-shaped paths so nested Orca PTYs don't create
# self-loop sourcing (zsh "recursion limit exceeded").
case "\${ORCA_ORIG_ZDOTDIR%/}" in
  */shell-ready/zsh) export ORCA_ORIG_ZDOTDIR="$HOME" ;;
esac
export ZDOTDIR=${quotePosixSingle(zshDir)}
`
}
