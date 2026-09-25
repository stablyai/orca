import { quotePosixShell } from '../../shared/wsl-login-shell-command'
import { WSL_CODEX_SESSION_BRIDGE_SCRIPT } from '../codex/wsl-codex-session-bridge-script'

export const RETIRED_SESSION_BRIDGE_COMMAND = `bash -c ${quotePosixShell(WSL_CODEX_SESSION_BRIDGE_SCRIPT)} bash "$legacy_home/sessions" "$target_home/sessions" "$session_link_manifest" "$session_stage_root"`
export const RETIRED_RECENT_SESSION_BRIDGE_COMMAND = `${RETIRED_SESSION_BRIDGE_COMMAND} recent "$session_scan_start" "$session_scan_day"`
const ROLLBACK_SESSION_LINKS_COMMAND = `bash -c ${quotePosixShell(`while IFS= read -r -d '' staged_file && IFS= read -r -d '' target_file; do
  if [ -e "$target_file" ] || [ -L "$target_file" ]; then
    [ -f "$staged_file" ] && [ ! -L "$staged_file" ] && [ "$target_file" -ef "$staged_file" ] || exit 1
    rm -- "$target_file" || exit 1
  fi
  if [ -e "$staged_file" ] || [ -L "$staged_file" ]; then
    [ -f "$staged_file" ] && [ ! -L "$staged_file" ] || exit 1
    rm -- "$staged_file" || exit 1
  fi
done < "$1"`)} bash`

const COMMIT_SESSION_LINKS_COMMAND = `bash -c ${quotePosixShell(`while IFS= read -r -d '' staged_file && IFS= read -r -d '' target_file; do
  if [ -e "$staged_file" ] || [ -L "$staged_file" ]; then
    [ -f "$staged_file" ] && [ ! -L "$staged_file" ] || exit 1
    rm -- "$staged_file" || exit 1
  fi
done < "$1"`)} bash`

export const RECOVER_DESTINATION_AUTH_COMMAND = `bash -c ${quotePosixShell(`IFS= read -r -d '' target_auth < "$1" || exit 1
case "$target_auth" in /*) ;; *) exit 1 ;; esac
if [ ! -e "$target_auth" ] && [ ! -L "$target_auth" ]; then
  mv -- "$2" "$target_auth" || exit 1
  chmod 600 "$target_auth" || exit 1
  rm -- "$1" || exit 1
elif [ -f "$target_auth" ] && [ ! -L "$target_auth" ] && [ "$target_auth" -ef "$2" ]; then
  chmod 600 "$target_auth" || exit 1
  rm -- "$2" "$1" || exit 1
else
  chmod 600 "$2" || exit 1
fi`)} bash "$destination_recovery_path" "$destination_recovery_auth"`

export const DISCARD_DESTINATION_RECOVERY_COMMAND = `bash -c ${quotePosixShell(`IFS= read -r -d '' recorded_target < "$1" || exit 1
[ "$recorded_target" = "$3" ] || exit 1
chmod 600 "$2" "$3" || exit 1
rm -- "$2" "$1" || exit 1`)} bash "$destination_recovery_path" "$destination_recovery_auth" "$target_auth"`

export const ROLLBACK_SESSION_LINKS_FUNCTION = `
rollback_session_links() {
  if [ -e "$session_commit_marker" ] || [ -L "$session_commit_marker" ]; then
    [ -f "$session_commit_marker" ] && [ ! -L "$session_commit_marker" ] || return 1
    commit_session_links || return 1
    return 0
  fi
  if [ -f "$session_link_manifest" ] && [ ! -L "$session_link_manifest" ]; then
    ${ROLLBACK_SESSION_LINKS_COMMAND} "$session_link_manifest" || return 1
    rm -- "$session_link_manifest" || return 1
  elif [ -e "$session_link_manifest" ] || [ -L "$session_link_manifest" ]; then
    return 1
  fi
  rm -rf -- "$session_stage_root" || return 1
}

commit_session_links() {
  if [ ! -e "$session_commit_marker" ] && [ ! -L "$session_commit_marker" ]; then
    : > "$session_commit_marker" || return 1
  fi
  [ -f "$session_commit_marker" ] && [ ! -L "$session_commit_marker" ] || return 1
  if [ -f "$session_link_manifest" ] && [ ! -L "$session_link_manifest" ]; then
    ${COMMIT_SESSION_LINKS_COMMAND} "$session_link_manifest" || return 1
    rm -- "$session_link_manifest" || return 1
  elif [ -e "$session_link_manifest" ] || [ -L "$session_link_manifest" ]; then
    return 1
  fi
  rm -rf -- "$session_stage_root" || return 1
  rm -- "$session_commit_marker" || return 1
}
`

export const RESOLVE_LEGACY_HOME_SCRIPT = `
legacy_home="$1"
legacy_home_resolved=0
if [ -e "$1" ] || [ -L "$1" ]; then
  legacy_home=$(readlink -f -- "$1") || exit 30
  legacy_home_resolved=1
fi
if [ -e "$2" ] || [ -L "$2" ]; then
  active_home=$(readlink -f -- "$2") || exit 31
  if [ "$legacy_home_resolved" = 1 ]; then
    [ "$active_home" = "$legacy_home" ] || exit 32
  else
    legacy_home="$active_home"
    legacy_home_resolved=1
  fi
fi
`
