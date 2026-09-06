import { quoteShell } from './cli-install-path-format'

/**
 * The root helper that applies a spooled serve update request.
 *
 * Why a shell script and not a binary: the helper must survive AppImage swaps (it lives at a
 * fixed path outside the bundle), must be auditable with `cat`, and its whole job is a
 * well-defined systemctl/sha512sum pipeline that a shell expresses without a build step.
 *
 * Contract (see docs/reference/headless-linux-server.md):
 * 1. Read the request from the spool; validate shape and unit name; refuse downgrades and
 *    no-op when already at the target version.
 * 2. Write { phase: "accepted" } — from here the app is allowed to quit.
 * 3. Re-hash the staged AppImage against the request's sha512 (the helper is the trust anchor:
 *    it verifies the file it will actually install, not just the metadata it was handed).
 * 4. Snapshot the current binary, systemctl stop the unit (census is the app's job).
 * 5. Copy the artifact onto the target filesystem, fsync, atomic rename; write VERSION.
 * 6. reset-failed, systemctl start, then verify readiness: the unit's new MainPID must emit
 *    the `orca_server_ready` journal line (the unit runs `serve --json`).
 * 7. Write { phase: "ok", targetVersion } on success; on any post-acceptance failure roll
 *    back to the snapshot, restart the old binary, and write { phase: "failed", reason }.
 * The request file is consumed at every terminal verdict so a stale request can never be
 * re-applied by a later invocation.
 */
export function buildServeUpdateHelperScript(input: {
  spoolDir: string
  unitName: string
  appImageTargetPath: string
  versionRecordPath: string
}): string {
  const q = quoteShell
  return `#!/usr/bin/env bash
set -euo pipefail
IFS=$'\\n\\t'

SPOOL_DIR=${q(input.spoolDir)}
UNIT_NAME=${q(input.unitName)}
APPIMAGE_TARGET=${q(input.appImageTargetPath)}
VERSION_TARGET=${q(input.versionRecordPath)}
REQUEST="$SPOOL_DIR/request.json"
RESULT="$SPOOL_DIR/result.json"
STAGING="$APPIMAGE_TARGET.new"
BACKUP="$APPIMAGE_TARGET.update-backup"
READY_TIMEOUT_SECONDS=60
LOG_TAG="orca-serve-update-helper"

log() { echo "[$LOG_TAG] $*" >&2; }

write_result() {
  local tmp
  tmp=$(mktemp "$SPOOL_DIR/result.XXXXXXXX")
  printf '%s' "$1" > "$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$RESULT"
}

# Every terminal verdict carries the attempt binding when the request was parsed
# (empty ATTEMPT_ID/TARGET_VERSION before that), so readServeUpdateResultFor can
# match rejections to this attempt instead of discarding them as stale.
reject() {
  log "rejected: $1"
  rm -f "$REQUEST"
  write_result '{"phase":"rejected","attemptId":"'"$ATTEMPT_ID"'","targetVersion":"'"$TARGET_VERSION"'","reason":'"$(printf '%s' "$1" | jq -Rs .)"'}'
  exit 0
}

fail() {
  log "failed: $1"
  rm -f "$REQUEST"
  write_result '{"phase":"failed","attemptId":"'"$ATTEMPT_ID"'","targetVersion":"'"$TARGET_VERSION"'","reason":'"$(printf '%s' "$1" | jq -Rs .)"'}'
  exit 0
}

# jq and flock are hard dependencies; without them no verdict can ever be
# written, so fail loudly instead of burning the app's 90s poll window.
if ! command -v jq >/dev/null 2>&1; then
  log "jq is required but not installed"
  rm -f "$REQUEST"
  write_result '{"phase":"failed","reason":"jq-missing"}'
  exit 0
fi
if ! command -v flock >/dev/null 2>&1; then
  log "flock is required but not installed"
  rm -f "$REQUEST"
  write_result '{"phase":"failed","reason":"flock-missing"}'
  exit 0
fi

if [[ $(id -u) -ne 0 ]]; then
  reject "helper must run as root"
fi

# Serialize concurrent invocations; the lock dies with this process.
exec 9>"$SPOOL_DIR/helper.lock"
if ! flock -w 30 9; then
  reject "another update is in progress"
fi

# A result left by a previous attempt must never be read as this one's verdict.
# Cleared under the lock so a concurrent helper cannot delete a live verdict.
rm -f "$RESULT"

if [[ ! -f "$REQUEST" ]]; then
  reject "no request spooled"
fi

REQUEST_JSON=$(cat "$REQUEST")
parse_field() {
  printf '%s' "$REQUEST_JSON" | jq -r ".$1 // empty"
}

SCHEMA=$(parse_field 'schemaVersion')
ATTEMPT_ID=$(parse_field 'attemptId')
TARGET_VERSION=$(parse_field 'targetVersion')
ARTIFACT_PATH=$(parse_field 'artifactPath')
SHA512=$(parse_field 'sha512')
SERVING_PID=$(parse_field 'servingPid')
REQUEST_UNIT=$(parse_field 'unitName')

if [[ "$SCHEMA" != "2" ]]; then
  reject "unsupported schema version: $SCHEMA"
fi
if [[ -z "$ATTEMPT_ID" || -z "$TARGET_VERSION" || -z "$ARTIFACT_PATH" || -z "$SHA512" ]]; then
  reject "incomplete request"
fi
if [[ "$REQUEST_UNIT" != "$UNIT_NAME" ]]; then
  reject "unit name mismatch: $REQUEST_UNIT"
fi
if ! [[ "$SERVING_PID" =~ ^[0-9]+$ ]]; then
  reject "invalid serving pid"
fi
if [[ ! -f "$ARTIFACT_PATH" ]]; then
  reject "artifact missing: $ARTIFACT_PATH"
fi
if ! systemctl list-unit-files "$UNIT_NAME" >/dev/null 2>&1; then
  reject "unit not found: $UNIT_NAME"
fi

# Trust anchor: re-hash the file that will actually be installed.
# The spooled sha512 is base64 of the raw 64-byte digest; hex-encode the decoded
# bytes and compare against sha512sum's hex output.
ACTUAL_SHA=$(sha512sum -- "$ARTIFACT_PATH" | awk '{print $1}')
# Why the || true: an undecodable digest must reach the length check and produce a
# rejected verdict, not kill the helper under set -e before any verdict is written.
EXPECTED_SHA=$(printf '%s' "$SHA512" | { base64 -d 2>/dev/null || true; } | od -An -v -tx1 | tr -d ' \\n')
if [[ \${#EXPECTED_SHA} -ne 128 || "$ACTUAL_SHA" != "$EXPECTED_SHA" ]]; then
  reject "artifact hash mismatch"
fi

if [[ ! -f "$APPIMAGE_TARGET" ]]; then
  reject "current binary missing: $APPIMAGE_TARGET"
fi
if [[ "$ARTIFACT_PATH" -ef "$APPIMAGE_TARGET" ]]; then
  reject "artifact is the live binary"
fi

CURRENT_VERSION=""
if [[ -f "$VERSION_TARGET" ]]; then
  CURRENT_VERSION=$(cat "$VERSION_TARGET")
fi
if [[ -n "$CURRENT_VERSION" ]]; then
  if [[ "$TARGET_VERSION" == "$CURRENT_VERSION" ]]; then
    reject "already at version $TARGET_VERSION"
  fi
  OLDEST=$(printf '%s\\n' "$CURRENT_VERSION" "$TARGET_VERSION" | sort -V | head -n 1)
  if [[ "$OLDEST" == "$TARGET_VERSION" ]]; then
    reject "refusing downgrade from $CURRENT_VERSION to $TARGET_VERSION"
  fi
fi

# From here the app may quit; the helper owns the unit.
write_result '{"phase":"accepted","attemptId":"'"$ATTEMPT_ID"'","targetVersion":"'"$TARGET_VERSION"'"}'
log "accepted request from pid $SERVING_PID for $TARGET_VERSION"

OLD_VERSION_RECORD="$CURRENT_VERSION"

# Roll back to the snapshot and bring the OLD binary back up; used for every
# post-acceptance failure so the unit is never left down.
rollback_and_fail() {
  set +e
  rm -f "$STAGING" "$VERSION_TARGET.tmp"
  if [[ -f "$BACKUP" ]]; then
    mv -f "$BACKUP" "$APPIMAGE_TARGET"
  fi
  if [[ -n "$OLD_VERSION_RECORD" ]]; then
    printf '%s\\n' "$OLD_VERSION_RECORD" > "$VERSION_TARGET" 2>/dev/null || true
  fi
  log "restarting unit after failure"
  systemctl reset-failed "$UNIT_NAME" 2>/dev/null || true
  systemctl start "$UNIT_NAME" 2>/dev/null || true
  fail "$1"
}

# Snapshot before touching anything so a failed swap or failed readiness can restore.
if ! cp -p -- "$APPIMAGE_TARGET" "$BACKUP"; then
  rm -f "$BACKUP"
  rollback_and_fail "could not snapshot current binary"
fi

# Stop before touching the binary; the FUSE mount holds the live image.
if ! systemctl stop "$UNIT_NAME"; then
  rollback_and_fail "could not stop $UNIT_NAME"
fi

# Copy (never mv) onto the target filesystem so a cross-device artifact still lands,
# then fsync + atomic rename. A partial copy can never be promoted.
if ! cp -- "$ARTIFACT_PATH" "$STAGING"; then
  rollback_and_fail "could not stage artifact"
fi
if ! chmod 0755 "$STAGING"; then
  rollback_and_fail "could not chmod staged artifact"
fi
if ! chown root:root "$STAGING"; then
  rollback_and_fail "could not chown staged artifact"
fi
sync -f "$STAGING" 2>/dev/null || sync || true

if ! mv -f "$STAGING" "$APPIMAGE_TARGET"; then
  rollback_and_fail "could not promote staged artifact"
fi

if ! printf '%s\\n' "$TARGET_VERSION" > "$VERSION_TARGET.tmp"; then
  rollback_and_fail "could not write version record"
fi
if ! mv -f "$VERSION_TARGET.tmp" "$VERSION_TARGET"; then
  rollback_and_fail "could not promote version record"
fi

# A tripped StartLimitBurst refuses a plain start.
systemctl reset-failed "$UNIT_NAME" 2>/dev/null || true
if ! systemctl start "$UNIT_NAME"; then
  rollback_and_fail "new binary failed to start"
fi

# Readiness: the unit's new MainPID must report orca_server_ready (unit runs serve --json).
wait_for_ready() {
  local deadline=$(( $(date +%s) + READY_TIMEOUT_SECONDS ))
  local pid
  while (( $(date +%s) < deadline )); do
    pid=$(systemctl show -p MainPID --value "$UNIT_NAME" 2>/dev/null || true)
    if [[ "$pid" =~ ^[0-9]+$ ]] && (( pid > 0 )); then
      if journalctl -u "$UNIT_NAME" _PID="$pid" -n 100 --no-pager 2>/dev/null | grep -q 'orca_server_ready'; then
        return 0
      fi
    fi
    sleep 1
  done
  return 1
}

if ! wait_for_ready; then
  rollback_and_fail "new binary did not report ready within $READY_TIMEOUT_SECONDS seconds"
fi

rm -f "$BACKUP"
write_result '{"phase":"ok","attemptId":"'"$ATTEMPT_ID"'","targetVersion":"'"$TARGET_VERSION"'"}'
log "update to $TARGET_VERSION applied"
`
}
