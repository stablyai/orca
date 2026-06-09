// Why: local PTYs and the daemon/SSH path must use identical ZDOTDIR discovery;
// small drift here breaks different terminal transports in different ways.

function quotePosixSingle(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function getZshEnvTemplate(zshDir: string, headerPrefix = ''): string {
  const header = headerPrefix
    ? `Orca ${headerPrefix} zsh shell-ready wrapper`
    : 'Orca zsh shell-ready wrapper'
  return `# ${header}
_orca_spawn_orig_zdotdir="\${ORCA_ORIG_ZDOTDIR:-}"
_orca_user_zdotdir="\${_orca_spawn_orig_zdotdir:-$HOME}"
_orca_zshenv_source_dir="\${ORCA_ZSHENV_SOURCE_DIR:-$HOME}"
_orca_zshenv_path=""
unset ORCA_ZSHENV_SOURCE_DIR

# Normalize fallback and source roots before reading user .zshenv so nested
# Orca PTYs never source another Orca wrapper recursively.
while [[ "\${_orca_user_zdotdir}" == */ ]]; do
  _orca_user_zdotdir="\${_orca_user_zdotdir%/}"
done
case "\${_orca_user_zdotdir}" in
  ""|*/shell-ready/zsh) _orca_user_zdotdir="$HOME" ;;
esac
while [[ "\${_orca_zshenv_source_dir}" == */ ]]; do
  _orca_zshenv_source_dir="\${_orca_zshenv_source_dir%/}"
done
case "\${_orca_zshenv_source_dir}" in
  ""|*/shell-ready/zsh) _orca_zshenv_source_dir="$HOME" ;;
esac

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

export ORCA_ORIG_ZDOTDIR="\${_orca_discovered_zdotdir:-\${_orca_user_zdotdir:-$HOME}}"

while [[ "\${ORCA_ORIG_ZDOTDIR}" == */ ]]; do
  ORCA_ORIG_ZDOTDIR="\${ORCA_ORIG_ZDOTDIR%/}"
done

case "\${ORCA_ORIG_ZDOTDIR}" in
  ""|*/shell-ready/zsh) export ORCA_ORIG_ZDOTDIR="$HOME" ;;
esac

export ZDOTDIR=${quotePosixSingle(zshDir)}
unset _orca_spawn_orig_zdotdir _orca_user_zdotdir _orca_zshenv_source_dir _orca_zshenv_path _orca_discovered_zdotdir
`
}

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

  return `_orca_home=${homeExpression}
case "\${_orca_home%/}" in
  */shell-ready/zsh) _orca_home="$HOME" ;;
esac
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

export function getZshFinalZdotdirRestoreBlock(homeExpression = '"${ORCA_ORIG_ZDOTDIR:-$HOME}"') {
  return `_orca_home=${homeExpression}
case "\${_orca_home%/}" in
  */shell-ready/zsh) _orca_home="$HOME" ;;
esac
# Why: after Orca's last wrapper file has loaded, the interactive shell should
# expose the same ZDOTDIR a normal zsh startup would expose.
export ZDOTDIR="$_orca_home"
unset _orca_home
`
}
