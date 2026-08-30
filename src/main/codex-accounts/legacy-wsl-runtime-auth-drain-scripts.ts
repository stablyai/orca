export const MARKER_PRESENT_EXIT = 20
export const SOURCE_AUTH_ABSENT_EXIT = 21

const RESOLVE_LEGACY_HOME_SCRIPT = `
legacy_home="$1"
legacy_home_resolved=0
if [ -e "$1" ] || [ -L "$1" ]; then legacy_home=$(readlink -f -- "$1") || exit 30; legacy_home_resolved=1; fi
if [ -e "$2" ] || [ -L "$2" ]; then active_home=$(readlink -f -- "$2") || exit 31; if [ "$legacy_home_resolved" = 1 ]; then [ "$active_home" = "$legacy_home" ] || exit 32; else legacy_home="$active_home"; legacy_home_resolved=1; fi; fi
`

export const INSPECT_LEGACY_AUTH_SCRIPT = `
set -eu
source_recovery_auth="$3.orca-drain-source"
source_quarantine_auth="$3.orca-drain-live-source"
destination_recovery_auth="$3.orca-drain-destination"
if [ -e "$3" ] || [ -L "$3" ]; then
  [ -f "$3" ] && [ ! -L "$3" ] || exit 46
  if [ -f "$destination_recovery_auth" ] && [ ! -L "$destination_recovery_auth" ]; then chmod 600 "$destination_recovery_auth"; fi
  rm -f -- "$source_recovery_auth" "$source_quarantine_auth" "$destination_recovery_auth"
  exit ${MARKER_PRESENT_EXIT}
fi
[ ! -e "$destination_recovery_auth" ] && [ ! -L "$destination_recovery_auth" ] || { [ -f "$destination_recovery_auth" ] && [ ! -L "$destination_recovery_auth" ] || exit 46; chmod 600 "$destination_recovery_auth"; }
${RESOLVE_LEGACY_HOME_SCRIPT}
source_auth="$legacy_home/auth.json"
if [ -e "$source_auth" ] || [ -L "$source_auth" ]; then
  [ -f "$source_auth" ] && [ ! -L "$source_auth" ] || exit 46
else
  if [ -f "$source_recovery_auth" ] && [ ! -L "$source_recovery_auth" ]; then
    mv -- "$source_recovery_auth" "$source_auth"; chmod 600 "$source_auth"
  elif [ -f "$source_quarantine_auth" ] && [ ! -L "$source_quarantine_auth" ]; then
    mv -- "$source_quarantine_auth" "$source_auth"; chmod 600 "$source_auth"
  elif [ -e "$source_quarantine_auth" ] || [ -L "$source_quarantine_auth" ] || [ -e "$source_recovery_auth" ] || [ -L "$source_recovery_auth" ]; then
    exit 46
  fi
fi
[ -f "$source_auth" ] && [ ! -L "$source_auth" ] || exit ${SOURCE_AUTH_ABSENT_EXIT}
encode_file() { base64 < "$1" | tr -d '\\n'; }
encode_file "$source_auth"; printf '\\n'
source_credentials="$legacy_home/.credentials.json"
if [ -f "$source_credentials" ] && [ ! -L "$source_credentials" ]; then printf 'present\\n'; encode_file "$source_credentials"; printf '\\n'; elif [ ! -e "$source_credentials" ] && [ ! -L "$source_credentials" ]; then printf 'missing\\n\\n'; else exit 44; fi
`

// Freeze a verified destination snapshot before source quarantine so the
// marker commits only while both credential copies remain recoverable.
export const APPLY_LEGACY_AUTH_SCRIPT = `
set -eu
source_recovery_auth="$3.orca-drain-source"
source_quarantine_auth="$3.orca-drain-live-source"
destination_recovery_auth="$3.orca-drain-destination"
if [ -e "$3" ] || [ -L "$3" ]; then
  [ -f "$3" ] && [ ! -L "$3" ] || exit 46
  if [ -f "$destination_recovery_auth" ] && [ ! -L "$destination_recovery_auth" ]; then chmod 600 "$destination_recovery_auth"; fi
  rm -f -- "$source_recovery_auth" "$source_quarantine_auth" "$destination_recovery_auth"
  exit 0
fi
${RESOLVE_LEGACY_HOME_SCRIPT}
target_home=$(readlink -f -- "$4") || exit 33
[ "$legacy_home" != "$target_home" ] || exit 34
source_auth="$legacy_home/auth.json"; target_auth="$target_home/auth.json"
[ -f "$source_auth" ] && [ ! -L "$source_auth" ] || exit 35; [ -f "$target_auth" ] && [ ! -L "$target_auth" ] || exit 36
hash_file() { sha256sum -- "$1" | cut -d ' ' -f 1; }
mode_file() { stat -c '%a' -- "$1"; }
if [ -e "$source_quarantine_auth" ] || [ -L "$source_quarantine_auth" ]; then
  [ -f "$source_quarantine_auth" ] && [ ! -L "$source_quarantine_auth" ] || exit 46
  [ "$(hash_file "$source_auth")" = "$5" ] || exit 37
  [ "$(hash_file "$source_quarantine_auth")" = "$5" ] || exit 40
  rm -- "$source_quarantine_auth"
fi
if [ -e "$source_recovery_auth" ] || [ -L "$source_recovery_auth" ]; then
  [ -f "$source_recovery_auth" ] && [ ! -L "$source_recovery_auth" ] || exit 46
  [ "$(hash_file "$source_auth")" = "$5" ] || exit 37
  [ "$(hash_file "$source_recovery_auth")" = "$5" ] || exit 40
  rm -- "$source_recovery_auth"
fi
if [ -e "$destination_recovery_auth" ] || [ -L "$destination_recovery_auth" ]; then
  [ -f "$destination_recovery_auth" ] && [ ! -L "$destination_recovery_auth" ] || exit 46
  if [ "$target_auth" -ef "$destination_recovery_auth" ]; then chmod 600 "$target_auth"; fi
  rm -- "$destination_recovery_auth"
fi
[ "$(hash_file "$source_auth")" = "$5" ] || exit 37
[ "$(hash_file "$target_auth")" = "$6" ] || exit 38
umask 077
temporary_auth="$target_auth.orca-drain-$$"; temporary_credentials="$target_home/.credentials.json.orca-drain-$$"; destination_pin="$target_auth.orca-drain-pin-$$"; temporary_destination_snapshot="$target_auth.orca-drain-snapshot-$$"; temporary_source_snapshot="$source_auth.orca-drain-source-$$"; temporary_marker="$3.orca-drain-$$"
drain_marker="$3"; expected_source_hash="$5"
marker_committed() { [ -f "$drain_marker" ] && [ ! -L "$drain_marker" ]; }
cleanup() {
  if ! marker_committed && [ ! -e "$source_auth" ] && [ ! -L "$source_auth" ]; then
    if [ -f "$source_recovery_auth" ] && [ ! -L "$source_recovery_auth" ] && [ "$(hash_file "$source_recovery_auth")" = "$expected_source_hash" ]; then mv -- "$source_recovery_auth" "$source_auth" || :; chmod 600 "$source_auth" || :
    elif [ -f "$source_quarantine_auth" ] && [ ! -L "$source_quarantine_auth" ] && [ "$(hash_file "$source_quarantine_auth")" = "$expected_source_hash" ]; then mv -- "$source_quarantine_auth" "$source_auth" || :; chmod 600 "$source_auth" || :; fi
  fi
  if [ -f "$destination_recovery_auth" ] && [ ! -L "$destination_recovery_auth" ]; then
    if [ "$target_auth" -ef "$destination_recovery_auth" ]; then chmod 600 "$target_auth" || :; fi
    if marker_committed; then rm -f -- "$destination_recovery_auth"; fi
  fi
  if marker_committed; then rm -f -- "$source_recovery_auth" "$source_quarantine_auth"; fi
  rm -f -- "$temporary_auth" "$temporary_credentials" "$destination_pin" "$temporary_destination_snapshot" "$temporary_source_snapshot" "$temporary_marker"
}
trap cleanup EXIT
trap 'cleanup; exit 129' HUP INT TERM
ln -- "$target_auth" "$destination_pin"
[ "$(hash_file "$destination_pin")" = "$6" ] || exit 38
[ "$target_auth" -ef "$destination_pin" ] || exit 38
source_credentials="$legacy_home/.credentials.json"; target_credentials="$target_home/.credentials.json"
if [ -f "$source_credentials" ] && [ ! -e "$target_credentials" ] && [ ! -L "$target_credentials" ]; then
  [ "$9" != missing ] || exit 43; [ "$(hash_file "$source_credentials")" = "$9" ] || exit 43
  cp -- "$source_credentials" "$temporary_credentials"; chmod 600 "$temporary_credentials"; [ "$(hash_file "$temporary_credentials")" = "$9" ] || exit 43; [ "$(hash_file "$source_credentials")" = "$9" ] || exit 43; mv -n -- "$temporary_credentials" "$target_credentials"; [ -f "$target_credentials" ] && [ ! -L "$target_credentials" ] && [ "$(hash_file "$target_credentials")" = "$9" ] || exit 43
elif [ "$9" = missing ] && [ ! -e "$target_credentials" ] && [ ! -L "$target_credentials" ]; then
  [ ! -e "$source_credentials" ] && [ ! -L "$source_credentials" ] || exit 43
fi
if [ "$7" = 1 ]; then
  cp -- "$source_auth" "$temporary_auth"; chmod 600 "$temporary_auth"; [ "$(hash_file "$temporary_auth")" = "$5" ] || exit 42
  [ "$(hash_file "$destination_pin")" = "$6" ] || exit 39; [ "$target_auth" -ef "$destination_pin" ] || exit 39
  mv -f -- "$temporary_auth" "$target_auth"
  [ "$(hash_file "$destination_pin")" = "$6" ] || exit 39
  rm -- "$destination_pin"; ln -- "$target_auth" "$destination_pin"
fi
expected_target_hash="$6"; [ "$7" != 1 ] || expected_target_hash="$5"
[ "$(hash_file "$destination_pin")" = "$expected_target_hash" ] || exit 45
[ "$target_auth" -ef "$destination_pin" ] || exit 45
if [ "$8" != 1 ]; then exit 0; fi
cp -- "$target_auth" "$temporary_destination_snapshot"; chmod 400 "$temporary_destination_snapshot"; [ "$(mode_file "$temporary_destination_snapshot")" = 400 ] || exit 45; [ "$(hash_file "$temporary_destination_snapshot")" = "$expected_target_hash" ] || exit 45
cp -- "$source_auth" "$temporary_source_snapshot"; chmod 400 "$temporary_source_snapshot"; [ "$(mode_file "$temporary_source_snapshot")" = 400 ] || exit 40; [ "$(hash_file "$temporary_source_snapshot")" = "$5" ] || exit 40
mv -f -- "$temporary_source_snapshot" "$source_recovery_auth"; [ "$(hash_file "$source_recovery_auth")" = "$5" ] || exit 40
ln -- "$temporary_destination_snapshot" "$destination_recovery_auth"; [ "$temporary_destination_snapshot" -ef "$destination_recovery_auth" ] || exit 45
[ "$(hash_file "$destination_pin")" = "$expected_target_hash" ] || exit 45; [ "$target_auth" -ef "$destination_pin" ] || exit 45
mv -f -- "$temporary_destination_snapshot" "$target_auth"
[ "$(hash_file "$destination_pin")" = "$expected_target_hash" ] || exit 45
[ "$(mode_file "$target_auth")" = 400 ] || exit 45
[ "$(hash_file "$target_auth")" = "$expected_target_hash" ] || exit 45
[ "$target_auth" -ef "$destination_recovery_auth" ] || exit 45
[ "$(hash_file "$source_auth")" = "$5" ] || exit 40
mv -- "$source_auth" "$source_quarantine_auth"; chmod 400 "$source_quarantine_auth"; [ "$(mode_file "$source_quarantine_auth")" = 400 ] || exit 40
[ "$(hash_file "$source_quarantine_auth")" = "$5" ] || exit 40
[ "$(hash_file "$target_auth")" = "$expected_target_hash" ] || exit 45
[ "$target_auth" -ef "$destination_recovery_auth" ] || exit 45
printf '%s\\n' '{"completed":true}' > "$temporary_marker"; chmod 600 "$temporary_marker"; mv -f -T -- "$temporary_marker" "$3"
marker_committed || exit 46
chmod 600 "$destination_recovery_auth"
`

export const FINALIZE_ABSENT_AUTH_SCRIPT = `
set -eu
if [ -e "$3" ] || [ -L "$3" ]; then [ -f "$3" ] && [ ! -L "$3" ] || exit 46; exit 0; fi
${RESOLVE_LEGACY_HOME_SCRIPT}
[ ! -e "$legacy_home/auth.json" ] && [ ! -L "$legacy_home/auth.json" ] || exit 41
umask 077; marker_parent=\${3%/*}; mkdir -p -- "$marker_parent"; temporary_marker="$3.orca-drain-$$"; trap 'rm -f -- "$temporary_marker"' EXIT; trap 'rm -f -- "$temporary_marker"; exit 129' HUP INT TERM; printf '%s\\n' '{"completed":true}' > "$temporary_marker"; chmod 600 "$temporary_marker"; mv -f -T -- "$temporary_marker" "$3"; [ -f "$3" ] && [ ! -L "$3" ] || exit 46
`
