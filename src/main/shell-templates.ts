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
 * Generates the zsh .zshenv wrapper that discovers user ZDOTDIR from ~/.zshenv.
 *
 * Sources user's ~/.zshenv in a subshell to discover their ZDOTDIR, validates and
 * normalizes it, then redirects ZDOTDIR to Orca's wrapper while preserving the
 * original in ORCA_ORIG_ZDOTDIR.
 *
 * @param zshDir - Absolute path to the Orca wrapper directory (will be set as ZDOTDIR)
 * @param headerPrefix - Optional header label (e.g., "daemon" → "Orca daemon zsh...")
 * @returns Shell script content for shell-ready/zsh/.zshenv
 */
export function getZshEnvTemplate(zshDir: string, headerPrefix = ''): string {
  const header = headerPrefix
    ? `Orca ${headerPrefix} zsh shell-ready wrapper`
    : 'Orca zsh shell-ready wrapper'
  return `# ${header}
# Discover user's ZDOTDIR from ~/.zshenv, then redirect to Orca wrapper
_orca_spawn_orig_zdotdir="\${ORCA_ORIG_ZDOTDIR:-}"
_orca_discovered_zdotdir=$(
  unset ZDOTDIR
  if [[ -n "\${HOME:-}" && -f "$HOME/.zshenv" ]]; then
    if [[ "\${ORCA_DEBUG:-0}" == "1" ]]; then
      source "$HOME/.zshenv"
    else
      source "$HOME/.zshenv" 2>/dev/null
    fi
  fi
  printf '%s\\n' "\${ZDOTDIR:-}"
)

# Normalize: strip all trailing slashes
while [[ "\${_orca_discovered_zdotdir}" == */ ]]; do
  _orca_discovered_zdotdir="\${_orca_discovered_zdotdir%/}"
done

# Reject whitespace-only values
case "\${_orca_discovered_zdotdir}" in
  *[![:space:]]*) ;;  # has non-whitespace, keep it
  *) _orca_discovered_zdotdir="" ;;  # whitespace-only or empty, clear it
esac

# Reject non-existent directories
if [[ -n "\${_orca_discovered_zdotdir}" && ! -d "\${_orca_discovered_zdotdir}" ]]; then
  [[ "\${ORCA_DEBUG:-0}" == "1" ]] && echo "[orca-shell-ready] Discovered ZDOTDIR '\${_orca_discovered_zdotdir}' does not exist, falling back" >&2
  _orca_discovered_zdotdir=""
fi

# Use discovered path, or previous value, or HOME
export ORCA_ORIG_ZDOTDIR="\${_orca_discovered_zdotdir:-\${_orca_spawn_orig_zdotdir:-$HOME}}"

# Guard against self-loops when Orca launches from within Orca
case "\${ORCA_ORIG_ZDOTDIR%/}" in
  */shell-ready/zsh) export ORCA_ORIG_ZDOTDIR="$HOME" ;;
esac

export ZDOTDIR=${quotePosixSingle(zshDir)}
`
}
