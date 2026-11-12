# Orca Cloud: sourced by every new bash/zsh (via /etc/profile.d) so terminals and agents started
# after a secret edit get the current values with no restart. The file is written by
# /opt/orca/bin/orca-sandbox-env on tmpfs; names it no longer lists are unset. Cloud secrets win
# over same-named values already in the environment.
__orca_env_file="/dev/shm/orca-env-$(id -u 2>/dev/null)/session.env"
if [ -r "$__orca_env_file" ]; then
  # $(...) word-splits in both bash and zsh.
  for __orca_n in $(printf '%s' "${ORCA_SESSION_ENV_NAMES-}"); do
    unset "$__orca_n" 2>/dev/null || true
  done
  __orca_names=''
  while IFS= read -r __orca_line || [ -n "$__orca_line" ]; do
    __orca_n="${__orca_line%%=*}"
    case "$__orca_n" in '' | *[!A-Z0-9_]* | [0-9]* | ORCA_* | PATH | HOME | LD_* | DYLD_*) continue ;; esac
    export "$__orca_n=$(printf '%s' "${__orca_line#*=}" | base64 -d 2>/dev/null)"
    __orca_names="$__orca_names $__orca_n"
  done <"$__orca_env_file"
  export ORCA_SESSION_ENV_NAMES="${__orca_names# }"
fi
# Default branch of the cloud workspace repo, once its first-boot clone exists (computed once per shell tree).
if [ -n "${ORCA_WORKSPACE_PATH-}" ] && [ -z "${ORCA_DEFAULT_BRANCH-}" ]; then
  __orca_branch="$(git -C "$ORCA_WORKSPACE_PATH" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)"
  if [ -n "$__orca_branch" ]; then
    export ORCA_DEFAULT_BRANCH="${__orca_branch#origin/}" CONDUCTOR_DEFAULT_BRANCH="${__orca_branch#origin/}"
  fi
fi
# CR-cmd-quiet: Orca's staged agent launch (` . '/tmp/orca-launch-….sh'`) stays out of zsh history.
# zsh records a line before running it, so the hook must exist first; the staged script itself
# drops the line from bash's history. eval: bash parses this file too.
if [ -n "${ZSH_VERSION-}" ]; then
  eval '__orca_skip_launch_history() { [[ $1 == *orca-launch-* ]] && return 1; return 0 }
  (( ${zshaddhistory_functions[(Ie)__orca_skip_launch_history]} )) || zshaddhistory_functions+=(__orca_skip_launch_history)'
fi
unset __orca_env_file __orca_line __orca_n __orca_names __orca_branch
