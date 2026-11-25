// Encode only on folder changes; re-send each prompt so a child shell's report cannot stick.
export const BASH_CWD_REPORT_BLOCK = `__orca_osc133_cwd_report() {
  if [[ -n "\${MSYSTEM:-}" && -z "\${WSL_DISTRO_NAME:-}" ]]; then
    # Virtual MSYS mounts need a native path probe; never publish them as Windows root folders.
    case "$PWD" in /[A-Za-z]|/[A-Za-z]/*|//*) ;; *) return 0 ;; esac
  fi
  if [[ "$PWD" != "\${__orca_cwd_reported-}" ]]; then
    __orca_cwd_reported=$PWD
    local LC_ALL=C __orca_e= __orca_c __orca_i
    for (( __orca_i = 0; __orca_i < \${#PWD}; __orca_i++ )); do
      __orca_c=\${PWD:__orca_i:1}
      case $__orca_c in
        [A-Za-z0-9/._~-]) __orca_e+=$__orca_c ;;
        *) builtin printf -v __orca_c '%d' "'$__orca_c"; builtin printf -v __orca_c '%%%02X' $(( __orca_c & 255 )); __orca_e+=$__orca_c ;;
      esac
    done
    if [[ -n "\${MSYSTEM:-}" && -z "\${WSL_DISTRO_NAME:-}" && "$__orca_e" != //* ]]; then
      __orca_e="/\${__orca_e:1:1}:/\${__orca_e:3}"
    fi
    __orca_cwd_encoded=$__orca_e
  fi
  builtin printf '\\033]7;file://localhost%s\\007' "\${__orca_cwd_encoded-}"
}`

export const ZSH_CWD_REPORT_BLOCK = `__orca_cwd_report() {
  builtin emulate -L zsh
  builtin setopt no_multibyte
  if [[ $PWD != \${__orca_cwd_reported-} ]]; then
    builtin typeset -g __orca_cwd_reported=$PWD
    local __orca_e= __orca_c __orca_i
    for (( __orca_i = 1; __orca_i <= $#PWD; __orca_i++ )); do
      __orca_c=$PWD[__orca_i]
      case $__orca_c in
        ([A-Za-z0-9/._~-]) __orca_e+=$__orca_c ;;
        (*) builtin printf -v __orca_c '%d' "'$__orca_c"; builtin printf -v __orca_c '%%%02X' $(( __orca_c & 255 )); __orca_e+=$__orca_c ;;
      esac
    done
    builtin typeset -g __orca_cwd_encoded=$__orca_e
  fi
  builtin printf '\\033]7;file://localhost%s\\007' "\${__orca_cwd_encoded-}"
}`
