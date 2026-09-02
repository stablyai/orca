import {
  LEGACY_HOME_ABSENT_EXIT,
  MARKER_PRESENT_EXIT,
  SOURCE_AUTH_ABSENT_EXIT
} from './legacy-wsl-runtime-auth-drain-exit-codes'
import {
  DISCARD_DESTINATION_RECOVERY_COMMAND,
  RECOVER_DESTINATION_AUTH_COMMAND,
  RESOLVE_LEGACY_HOME_SCRIPT,
  RETIRED_SESSION_BRIDGE_COMMAND,
  RETIRED_RECENT_SESSION_BRIDGE_COMMAND,
  ROLLBACK_SESSION_LINKS_FUNCTION
} from './legacy-wsl-runtime-auth-drain-shell-commands'
export * from './legacy-wsl-runtime-auth-drain-exit-codes'
export { FINALIZE_ABSENT_AUTH_SCRIPT } from './legacy-wsl-runtime-auth-finalize-script'
export const INSPECT_LEGACY_AUTH_SCRIPT = `
set -eu
source_recovery_auth="$3.orca-drain-source"
source_quarantine_auth="$3.orca-drain-live-source"
destination_recovery_auth="$3.orca-drain-destination"
destination_recovery_path="$3.orca-drain-destination-path"
session_link_manifest="$3.orca-drain-session-links"
session_commit_marker="$3.orca-drain-session-commit"
session_stage_root="$3.orca-drain-session-stage"
${ROLLBACK_SESSION_LINKS_FUNCTION}
${RESOLVE_LEGACY_HOME_SCRIPT}
source_auth="$legacy_home/auth.json"
if [ -e "$3" ] || [ -L "$3" ]; then
  [ -f "$3" ] && [ ! -L "$3" ] || exit 46
  commit_session_links || exit 46
  if [ -f "$destination_recovery_auth" ] && [ ! -L "$destination_recovery_auth" ]; then
    chmod 600 "$destination_recovery_auth"
  fi
  rm -f -- "$source_recovery_auth" "$source_quarantine_auth" "$destination_recovery_auth" "$destination_recovery_path"
  if [ ! -e "$source_auth" ] && [ ! -L "$source_auth" ]; then
    exit ${MARKER_PRESENT_EXIT}
  fi
  [ -f "$source_auth" ] && [ ! -L "$source_auth" ] || exit 46
  rm -- "$3"
fi
rollback_session_links
if [ "$legacy_home_resolved" = 0 ]; then
  exit ${LEGACY_HOME_ABSENT_EXIT}
fi
if [ ! -e "$source_auth" ] && [ ! -L "$source_auth" ]; then
  if [ -f "$source_recovery_auth" ] && [ ! -L "$source_recovery_auth" ]; then
    mv -- "$source_recovery_auth" "$source_auth"
    chmod 600 "$source_auth"
  elif [ -f "$source_quarantine_auth" ] && [ ! -L "$source_quarantine_auth" ]; then
    mv -- "$source_quarantine_auth" "$source_auth"
    chmod 600 "$source_auth"
  elif [ -e "$source_recovery_auth" ] || [ -L "$source_recovery_auth" ]; then
    exit 46
  fi
fi
if [ -e "$destination_recovery_auth" ] || [ -L "$destination_recovery_auth" ]; then
  [ -f "$destination_recovery_auth" ] && [ ! -L "$destination_recovery_auth" ] || exit 46
  [ -f "$destination_recovery_path" ] && [ ! -L "$destination_recovery_path" ] || exit 46
  ${RECOVER_DESTINATION_AUTH_COMMAND} || exit 46
elif [ -e "$destination_recovery_path" ] || [ -L "$destination_recovery_path" ]; then
  [ -f "$destination_recovery_path" ] && [ ! -L "$destination_recovery_path" ] || exit 46
  rm -- "$destination_recovery_path"
fi
if [ ! -e "$source_auth" ] && [ ! -L "$source_auth" ]; then
  exit ${SOURCE_AUTH_ABSENT_EXIT}
fi
[ -f "$source_auth" ] && [ ! -L "$source_auth" ] || exit 46
encode_file() {
  encoded=$(base64 < "$1") || return 1
  printf '%s' "$encoded" | tr -d '\n'
}
encode_file "$source_auth"
printf '\n'
source_credentials="$legacy_home/.credentials.json"
if [ -f "$source_credentials" ] && [ ! -L "$source_credentials" ]; then
  printf 'present\n'
  encode_file "$source_credentials"
  printf '\n'
elif [ ! -e "$source_credentials" ] && [ ! -L "$source_credentials" ]; then
  printf 'missing\n\n'
else
  exit 44
fi
`

export const APPLY_LEGACY_AUTH_SCRIPT = `
set -eu
source_recovery_auth="$3.orca-drain-source"
source_quarantine_auth="$3.orca-drain-live-source"
destination_recovery_auth="$3.orca-drain-destination"
destination_recovery_path="$3.orca-drain-destination-path"
session_link_manifest="$3.orca-drain-session-links"
session_commit_marker="$3.orca-drain-session-commit"
session_stage_root="$3.orca-drain-session-stage"
session_scan_watermark="$3.orca-drain-session-watermark"
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
${RESOLVE_LEGACY_HOME_SCRIPT}
target_home=$(readlink -f -- "$4") || exit 33
[ "$legacy_home" != "$target_home" ] || exit 34
source_auth="$legacy_home/auth.json"
target_auth="$target_home/auth.json"
if [ ! -e "$source_auth" ] && [ ! -L "$source_auth" ]; then exit 35; fi
[ -f "$source_auth" ] && [ ! -L "$source_auth" ] || exit 46
if [ ! -e "$target_auth" ] && [ ! -L "$target_auth" ]; then exit 36; fi
[ -f "$target_auth" ] && [ ! -L "$target_auth" ] || exit 46
hash_file() { sha256sum -- "$1" | cut -d ' ' -f 1; }
[ "$(hash_file "$source_auth")" = "$5" ] || exit 37
[ "$(hash_file "$target_auth")" = "$6" ] || exit 38
if [ -e "$source_quarantine_auth" ] || [ -L "$source_quarantine_auth" ]; then
  [ -f "$source_quarantine_auth" ] && [ ! -L "$source_quarantine_auth" ] || exit 46
  rm -- "$source_quarantine_auth"
fi
if [ -e "$destination_recovery_auth" ] || [ -L "$destination_recovery_auth" ] || [ -e "$destination_recovery_path" ] || [ -L "$destination_recovery_path" ]; then
  [ -f "$destination_recovery_auth" ] && [ ! -L "$destination_recovery_auth" ] || exit 46
  [ -f "$destination_recovery_path" ] && [ ! -L "$destination_recovery_path" ] || exit 46
  ${DISCARD_DESTINATION_RECOVERY_COMMAND} || exit 46
fi
umask 077
temporary_auth="$target_auth.orca-drain-$$"
temporary_credentials="$target_home/.credentials.json.orca-drain-$$"
temporary_previous_auth="$target_auth.orca-drain-previous-$$"
temporary_destination_auth="$target_auth.orca-drain-destination-$$"
temporary_source_auth="$source_auth.orca-drain-source-$$"
temporary_destination_snapshot="$target_auth.orca-drain-snapshot-$$"
temporary_destination_path="$3.orca-drain-destination-path-$$"
temporary_source_snapshot="$3.orca-drain-source-$$"
temporary_marker="$3.orca-drain-$$"
temporary_session_scan_watermark="$session_scan_watermark.$$"
drain_marker="$3"
expected_source_hash="$5"
cleanup() {
  if [ ! -f "$drain_marker" ]; then
    rollback_session_links
  else
    commit_session_links || :
  fi
  if [ ! -f "$drain_marker" ] && [ ! -e "$source_auth" ] && [ ! -L "$source_auth" ]; then
    if [ -f "$source_recovery_auth" ] && [ ! -L "$source_recovery_auth" ] && [ "$(hash_file "$source_recovery_auth")" = "$expected_source_hash" ]; then
      mv -- "$source_recovery_auth" "$source_auth" || :
      chmod 600 "$source_auth" || :
    elif [ -f "$source_quarantine_auth" ] && [ ! -L "$source_quarantine_auth" ] && [ "$(hash_file "$source_quarantine_auth")" = "$expected_source_hash" ]; then
      mv -- "$source_quarantine_auth" "$source_auth" || :
      chmod 600 "$source_auth" || :
    fi
  elif [ ! -f "$drain_marker" ]; then
    # A late writer owns the recreated path; retain verified recovery artifacts for retry.
    :
  elif [ -f "$drain_marker" ]; then
    rm -f -- "$source_recovery_auth" "$source_quarantine_auth" "$destination_recovery_path"
  fi
  if [ -f "$drain_marker" ]; then
    if [ -f "$destination_recovery_auth" ] && [ ! -L "$destination_recovery_auth" ]; then
      chmod 600 "$destination_recovery_auth" || :
    fi
    rm -f -- "$destination_recovery_auth" "$destination_recovery_path"
  elif [ -e "$destination_recovery_auth" ] || [ -L "$destination_recovery_auth" ]; then
    if [ -f "$destination_recovery_auth" ] && [ ! -L "$destination_recovery_auth" ] && [ -f "$destination_recovery_path" ] && [ ! -L "$destination_recovery_path" ]; then
      ${RECOVER_DESTINATION_AUTH_COMMAND} || :
    fi
  elif [ -f "$destination_recovery_path" ] && [ ! -L "$destination_recovery_path" ]; then
    rm -f -- "$destination_recovery_path"
  fi
  if [ -f "$target_auth" ]; then
    chmod 600 "$target_auth" || :
  fi
  rm -f -- "$temporary_auth" "$temporary_credentials" "$temporary_previous_auth" "$temporary_destination_auth" "$temporary_source_auth" "$temporary_destination_snapshot" "$temporary_destination_path" "$temporary_source_snapshot" "$temporary_marker" "$temporary_session_scan_watermark"
}
trap cleanup EXIT HUP INT TERM
if [ "$8" != 1 ]; then
  session_scan_start=''; session_scan_day=$(date +%Y/%m/%d) || exit 46
  if [ -f "$session_scan_watermark" ] && [ ! -L "$session_scan_watermark" ]; then
    [ "\${10}" != recent ] || IFS= read -r session_scan_start < "$session_scan_watermark" || session_scan_start=''
  elif [ -e "$session_scan_watermark" ] && [ ! -L "$session_scan_watermark" ]; then exit 46
  fi
fi
source_credentials="$legacy_home/.credentials.json"
target_credentials="$target_home/.credentials.json"
if [ -f "$source_credentials" ] && [ ! -e "$target_credentials" ] && [ ! -L "$target_credentials" ]; then
  [ "$9" != missing ] || exit 43
  [ "$(hash_file "$source_credentials")" = "$9" ] || exit 43
  cp -- "$source_credentials" "$temporary_credentials"
  chmod 600 "$temporary_credentials"
  [ "$(hash_file "$temporary_credentials")" = "$9" ] || exit 43
  [ "$(hash_file "$source_credentials")" = "$9" ] || exit 43
  mv -n -- "$temporary_credentials" "$target_credentials"
elif [ "$9" = missing ] && [ ! -e "$target_credentials" ] && [ ! -L "$target_credentials" ]; then
  [ ! -e "$source_credentials" ] && [ ! -L "$source_credentials" ] || exit 43
fi
if [ "$7" = 1 ]; then
  cp -- "$source_auth" "$temporary_auth"
  chmod 600 "$temporary_auth"
  # Codex rewrites auth.json in place, so this copy is a second read: verify the
  # bytes being promoted, not the ones freshness was judged on.
  [ "$(hash_file "$temporary_auth")" = "$5" ] || exit 42
  [ "$(hash_file "$target_auth")" = "$6" ] || exit 39
  # The hard link keeps the destination inode observable without creating a
  # missing-path crash window. In-place writers update both names.
  ln -- "$target_auth" "$temporary_previous_auth"
  [ "$(hash_file "$temporary_previous_auth")" = "$6" ] || exit 39
  mv -f -- "$temporary_auth" "$target_auth"
  if [ "$(hash_file "$temporary_previous_auth")" != "$6" ]; then
    mv -f -- "$temporary_previous_auth" "$target_auth"
    exit 39
  fi
  rm -- "$temporary_previous_auth"
fi
if [ "$8" != 1 ]; then
  expected_target_hash="$6"
  [ "$7" != 1 ] || expected_target_hash="$5"
  # Keep both live auth inodes observable while links are staged, then prove
  # the paths still name those identities before publishing the bridge.
  ln -- "$source_auth" "$temporary_source_auth"
  ln -- "$target_auth" "$temporary_destination_auth"
  [ "$(hash_file "$temporary_source_auth")" = "$5" ] || exit 40
  [ "$(hash_file "$temporary_destination_auth")" = "$expected_target_hash" ] || exit 45
  [ "$source_auth" -ef "$temporary_source_auth" ] || exit 40
  [ "$target_auth" -ef "$temporary_destination_auth" ] || exit 45
  if [ "\${10}" = full ]; then
    ${RETIRED_SESSION_BRIDGE_COMMAND}
  elif [ "\${10}" = recent ]; then
    case "$session_scan_start" in
      ????/??/??) ${RETIRED_RECENT_SESSION_BRIDGE_COMMAND} ;;
      *) ${RETIRED_SESSION_BRIDGE_COMMAND} ;;
    esac
  else
    exit 46
  fi
  [ "$(hash_file "$temporary_source_auth")" = "$5" ] || exit 40
  [ "$(hash_file "$temporary_destination_auth")" = "$expected_target_hash" ] || exit 45
  [ "$source_auth" -ef "$temporary_source_auth" ] || exit 40
  [ "$target_auth" -ef "$temporary_destination_auth" ] || exit 45
  rm -- "$temporary_source_auth" "$temporary_destination_auth"
  commit_session_links
  printf '%s\n' "$session_scan_day" > "$temporary_session_scan_watermark"
  chmod 600 "$temporary_session_scan_watermark"
  mv -f -- "$temporary_session_scan_watermark" "$session_scan_watermark"
fi
if [ "$8" = 1 ]; then
  expected_target_hash="$6"
  [ "$7" != 1 ] || expected_target_hash="$5"
  # Pin the live inode and stage independent snapshots before retiring the source.
  ln -- "$target_auth" "$temporary_destination_auth"
  [ "$(hash_file "$temporary_destination_auth")" = "$expected_target_hash" ] || exit 45
  [ "$target_auth" -ef "$temporary_destination_auth" ] || exit 45
  cp -- "$target_auth" "$temporary_destination_snapshot"
  chmod 400 "$temporary_destination_snapshot"
  [ "$(hash_file "$temporary_destination_snapshot")" = "$expected_target_hash" ] || exit 45
  cp -- "$source_auth" "$temporary_source_snapshot"
  chmod 400 "$temporary_source_snapshot"
  [ "$(hash_file "$temporary_source_snapshot")" = "$5" ] || exit 40
  [ "$(hash_file "$source_auth")" = "$5" ] || exit 40
  mv -f -- "$temporary_source_snapshot" "$source_recovery_auth"
  [ "$(hash_file "$source_recovery_auth")" = "$5" ] || exit 40
  printf '%s\\0' "$target_auth" > "$temporary_destination_path"
  chmod 600 "$temporary_destination_path"
  mv -f -- "$temporary_destination_path" "$destination_recovery_path"
  ln -- "$temporary_destination_snapshot" "$destination_recovery_auth"
  [ "$temporary_destination_snapshot" -ef "$destination_recovery_auth" ] || exit 45
  [ "$(hash_file "$destination_recovery_auth")" = "$expected_target_hash" ] || exit 45
  [ "$(hash_file "$temporary_destination_auth")" = "$expected_target_hash" ] || exit 45
  [ "$target_auth" -ef "$temporary_destination_auth" ] || exit 45
  [ "$(hash_file "$temporary_destination_snapshot")" = "$expected_target_hash" ] || exit 45
  # The atomic replacement detaches the destination path from any writer that
  # already opened the old inode; read-only mode blocks new writers until commit.
  mv -f -- "$temporary_destination_snapshot" "$target_auth"
  if [ "$(hash_file "$temporary_destination_auth")" != "$expected_target_hash" ]; then
    mv -f -- "$temporary_destination_auth" "$target_auth"
    exit 45
  fi
  [ "$(hash_file "$target_auth")" = "$expected_target_hash" ] || exit 45
  [ "$target_auth" -ef "$destination_recovery_auth" ] || exit 45
  [ "$(hash_file "$destination_recovery_auth")" = "$expected_target_hash" ] || exit 45
  [ "$(hash_file "$source_auth")" = "$5" ] || exit 40
  mv -- "$source_auth" "$source_quarantine_auth"
  chmod 400 "$source_quarantine_auth"
  [ "$(hash_file "$source_quarantine_auth")" = "$5" ] || exit 40
  ${RETIRED_SESSION_BRIDGE_COMMAND}
  [ ! -e "$source_auth" ] && [ ! -L "$source_auth" ] || exit 40
  [ "$(hash_file "$source_quarantine_auth")" = "$5" ] || exit 40
  [ "$(hash_file "$target_auth")" = "$expected_target_hash" ] || exit 45
  [ "$target_auth" -ef "$destination_recovery_auth" ] || exit 45
  [ "$(hash_file "$destination_recovery_auth")" = "$expected_target_hash" ] || exit 45
  commit_session_links
  rm -- "$temporary_destination_auth"
  printf '%s\n' '{"completed":true}' > "$temporary_marker"
  chmod 600 "$temporary_marker"
  mv -f -- "$temporary_marker" "$3"
  chmod 600 "$destination_recovery_auth"
  rm -- "$source_recovery_auth" "$source_quarantine_auth" "$destination_recovery_auth" "$destination_recovery_path"
fi
`
