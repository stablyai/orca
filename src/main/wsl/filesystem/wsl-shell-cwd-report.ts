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

/**
 * A WSL bridge sh/dash/ash pane's ENV file (read once, by interactive shells only, after the login
 * profile). It first hands ENV back to the user's own value, so children see theirs, and sources it.
 * Then, inside WSL, it prefixes PS1 with the folder report; dash has no prompt hook, so the report
 * runs in a command substitution and re-encodes $PWD byte by byte every prompt. bash and busybox
 * ash (fancy prompt, on in Alpine's and Debian's builds) get it inside \\[ \\] so the invisible bytes
 * do not count toward the prompt's width; dash has no line editor to miscount, and would print \\[.
 */
export const SH_WSL_ENV_FILE = `# Orca WSL bridge sh ENV: restore the user's ENV, then report the folder (OSC 7) at each prompt.
if [ -n "\${ORCA_WSL_USER_ENV:-}" ]; then
  ENV=$ORCA_WSL_USER_ENV
  unset ORCA_WSL_USER_ENV
  # The shell expands ENV's value before reading it; a here-document does the same without
  # parsing the user's quotes as shell syntax.
  eval "IFS= read -r __orca_user_env <<__ORCA_USER_ENV_EOF
$ENV
__ORCA_USER_ENV_EOF
"
  if [ -r "$__orca_user_env" ]; then
    . "$__orca_user_env"
  fi
  unset __orca_user_env
else
  unset ENV ORCA_WSL_USER_ENV
fi
if [ -n "\${WSL_DISTRO_NAME:-}" ]; then
  __orca_wsl_cwd_report() {
    LC_ALL=C
    __orca_p=$PWD
    __orca_e=
    while [ -n "$__orca_p" ]; do
      __orca_r=\${__orca_p#?}
      __orca_c=\${__orca_p%"$__orca_r"}
      __orca_p=$__orca_r
      case $__orca_c in
        [A-Za-z0-9/._~-]) __orca_e=$__orca_e$__orca_c ;;
        *) __orca_e=$__orca_e$(printf '%%%02X' $(( $(printf '%d' "'$__orca_c") & 255 ))) ;;
      esac
    done
    printf '\\033]7;file://%s\\007' "$__orca_e"
  }
  case $PS1 in
    *__orca_wsl_cwd_report*) ;;
    *)
      if [ -n "\${BASH_VERSION:-}" ] || [ -n "\${BB_ASH_VERSION:-}" ]; then
        PS1='\\[$(__orca_wsl_cwd_report)\\]'"$PS1"
      else
        PS1='$(__orca_wsl_cwd_report)'"$PS1"
      fi
      ;;
  esac
fi
`
