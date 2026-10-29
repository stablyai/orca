/**
 * A WSL bridge shell reports its folder at each prompt (OSC 7), so the terminal daemon's emulator,
 * and every checkpoint, follows `cd` without a guest probe. Bridge bash and zsh send none
 * themselves. Only inside WSL. The path is encoded only when it changes, and re-sent every
 * prompt so a foreign report (an ssh session that set its own) cannot stick. Bytes outside the
 * URI's unreserved set are percent-encoded as UTF-8, masked for bash 3.2's signed chars.
 */
export const BASH_WSL_CWD_REPORT_BLOCK = `__orca_wsl_cwd_report() {
  [[ -n "\${WSL_DISTRO_NAME:-}" ]] || return 0
  if [[ "$PWD" != "\${__orca_wsl_cwd_reported-}" ]]; then
    __orca_wsl_cwd_reported=$PWD
    local LC_ALL=C __orca_e= __orca_c __orca_i
    for (( __orca_i = 0; __orca_i < \${#PWD}; __orca_i++ )); do
      __orca_c=\${PWD:__orca_i:1}
      case $__orca_c in
        [A-Za-z0-9/._~-]) __orca_e+=$__orca_c ;;
        *) printf -v __orca_c '%d' "'$__orca_c"; printf -v __orca_c '%%%02X' $(( __orca_c & 255 )); __orca_e+=$__orca_c ;;
      esac
    done
    __orca_wsl_cwd_encoded=$__orca_e
  fi
  printf '\\033]7;file://%s\\007' "\${__orca_wsl_cwd_encoded-}"
}`

export const ZSH_WSL_CWD_REPORT_BLOCK = `__orca_wsl_cwd_report() {
  builtin emulate -L zsh
  builtin setopt no_multibyte
  [[ -n \${WSL_DISTRO_NAME:-} ]] || return 0
  if [[ $PWD != \${__orca_wsl_cwd_reported-} ]]; then
    builtin typeset -g __orca_wsl_cwd_reported=$PWD
    local __orca_e= __orca_c __orca_i
    for (( __orca_i = 1; __orca_i <= $#PWD; __orca_i++ )); do
      __orca_c=$PWD[__orca_i]
      case $__orca_c in
        ([A-Za-z0-9/._~-]) __orca_e+=$__orca_c ;;
        (*) builtin printf -v __orca_c '%d' "'$__orca_c"; builtin printf -v __orca_c '%%%02X' $(( __orca_c & 255 )); __orca_e+=$__orca_c ;;
      esac
    done
    builtin typeset -g __orca_wsl_cwd_encoded=$__orca_e
  fi
  builtin printf '\\033]7;file://%s\\007' "\${__orca_wsl_cwd_encoded-}"
}`
