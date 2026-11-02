import { LEGACY_HOME_STILL_PRESENT_EXIT } from './legacy-wsl-runtime-auth-drain-exit-codes'
import {
  RECOVER_DESTINATION_AUTH_COMMAND,
  RESOLVE_LEGACY_HOME_SCRIPT,
  ROLLBACK_SESSION_LINKS_FUNCTION
} from './legacy-wsl-runtime-auth-drain-shell-commands'

export const FINALIZE_ABSENT_AUTH_SCRIPT = `
set -eu
source_recovery_auth="$3.orca-drain-source"
source_quarantine_auth="$3.orca-drain-live-source"
destination_recovery_auth="$3.orca-drain-destination"
destination_recovery_path="$3.orca-drain-destination-path"
session_link_manifest="$3.orca-drain-session-links"
session_commit_marker="$3.orca-drain-session-commit"
session_stage_root="$3.orca-drain-session-stage"
${ROLLBACK_SESSION_LINKS_FUNCTION}
if [ -e "$3" ] || [ -L "$3" ]; then
  [ -f "$3" ] && [ ! -L "$3" ] || exit 46
  commit_session_links || exit 46
  if [ -f "$destination_recovery_auth" ] && [ ! -L "$destination_recovery_auth" ]; then
    chmod 600 "$destination_recovery_auth"
  fi
  rm -f -- "$source_recovery_auth" "$source_quarantine_auth" "$destination_recovery_auth" "$destination_recovery_path"
  exit 0
fi
rollback_session_links
${RESOLVE_LEGACY_HOME_SCRIPT}
if [ -f "$source_recovery_auth" ] && [ ! -L "$source_recovery_auth" ]; then
  [ ! -e "$legacy_home/auth.json" ] && [ ! -L "$legacy_home/auth.json" ] || exit 41
  mv -- "$source_recovery_auth" "$legacy_home/auth.json"
  chmod 600 "$legacy_home/auth.json"
  if [ -e "$destination_recovery_auth" ] || [ -L "$destination_recovery_auth" ]; then
    [ -f "$destination_recovery_auth" ] && [ ! -L "$destination_recovery_auth" ] || exit 46
    [ -f "$destination_recovery_path" ] && [ ! -L "$destination_recovery_path" ] || exit 46
    ${RECOVER_DESTINATION_AUTH_COMMAND} || exit 46
  elif [ -e "$destination_recovery_path" ] || [ -L "$destination_recovery_path" ]; then
    [ -f "$destination_recovery_path" ] && [ ! -L "$destination_recovery_path" ] || exit 46
    rm -- "$destination_recovery_path"
  fi
  exit 46
fi
if [ -f "$source_quarantine_auth" ] && [ ! -L "$source_quarantine_auth" ]; then
  [ ! -e "$legacy_home/auth.json" ] && [ ! -L "$legacy_home/auth.json" ] || exit 41
  mv -- "$source_quarantine_auth" "$legacy_home/auth.json"
  chmod 600 "$legacy_home/auth.json"
  if [ -e "$destination_recovery_auth" ] || [ -L "$destination_recovery_auth" ]; then
    [ -f "$destination_recovery_auth" ] && [ ! -L "$destination_recovery_auth" ] || exit 46
    [ -f "$destination_recovery_path" ] && [ ! -L "$destination_recovery_path" ] || exit 46
    ${RECOVER_DESTINATION_AUTH_COMMAND} || exit 46
  elif [ -e "$destination_recovery_path" ] || [ -L "$destination_recovery_path" ]; then
    [ -f "$destination_recovery_path" ] && [ ! -L "$destination_recovery_path" ] || exit 46
    rm -- "$destination_recovery_path"
  fi
  exit 46
fi
[ ! -e "$source_recovery_auth" ] && [ ! -L "$source_recovery_auth" ] || exit 46
[ ! -e "$source_quarantine_auth" ] && [ ! -L "$source_quarantine_auth" ] || exit 46
[ ! -e "$destination_recovery_auth" ] && [ ! -L "$destination_recovery_auth" ] || exit 46
[ ! -e "$destination_recovery_path" ] && [ ! -L "$destination_recovery_path" ] || exit 46
[ ! -e "$legacy_home/auth.json" ] && [ ! -L "$legacy_home/auth.json" ] || exit 41
[ "$legacy_home_resolved" = 0 ] || exit ${LEGACY_HOME_STILL_PRESENT_EXIT}
umask 077
marker_parent=\${3%/*}
mkdir -p -- "$marker_parent"
temporary_marker="$3.orca-drain-$$"
trap 'rm -f -- "$temporary_marker"' EXIT HUP INT TERM
printf '%s\n' '{"completed":true}' > "$temporary_marker"
chmod 600 "$temporary_marker"
mv -f -- "$temporary_marker" "$3"
`
