import { quoteShell } from './cli-install-path-format'

/**
 * The root helper that applies a spooled serve update request.
 *
 * Why a shell script and not a binary: the helper must survive AppImage swaps (it lives at a
 * fixed path outside the bundle), must be auditable with `cat`, and its whole job is a
 * well-defined systemctl/sha512sum pipeline that a shell expresses without a build step.
 *
 * Contract (see docs/reference/headless-linux-server.md):
 * 1. Read the request from the spool; validate shape and unit name.
 * 2. Write { phase: "accepted" } — from here the app is allowed to quit.
 * 3. Re-hash the staged AppImage against the request's sha512 (the helper is the trust anchor:
 *    it verifies the file it will actually install, not just the metadata it was handed).
 * 4. systemctl stop the unit (census is the app's job).
 * 5. Copy the artifact onto the target filesystem, fsync, atomic rename.
 * 6. Write VERSION, reset-failed, systemctl start.
 * 7. Write { phase: "ok", targetVersion } on success.
 * Any failure after acceptance writes { phase: "failed", reason }; after a stop the unit is
 * always restarted, with the old binary still in place unless the swap already succeeded.
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
LOG_TAG="orca-serve-update-helper"

log() { echo "[$LOG_TAG] $*" >&2; }

write_result() {
  local tmp="$RESULT.$$.tmp"
  printf '%s' "$1" > "$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$RESULT"
}

reject() {
  log "rejected: $1"
  write_result '{"phase":"rejected","reason":'"$(printf '%s' "$1" | jq -Rs .)"'}'
  exit 0
}

fail() {
  log "failed: $1"
  write_result '{"phase":"failed","reason":'"$(printf '%s' "$1" | jq -Rs .)"'}'
  exit 0
}

# A result left by a previous attempt must never be read as this one's verdict.
rm -f "$RESULT"

if [[ $(id -u) -ne 0 ]]; then
  reject "helper must run as root"
fi

if [[ ! -f "$REQUEST" ]]; then
  reject "no request spooled"
fi

REQUEST_JSON=$(cat "$REQUEST")
parse_field() {
  printf '%s' "$REQUEST_JSON" | jq -r ".$1 // empty"
}

SCHEMA=$(parse_field 'schemaVersion')
RUNTIME_ID=$(parse_field 'runtimeId')
TARGET_VERSION=$(parse_field 'targetVersion')
ARTIFACT_PATH=$(parse_field 'artifactPath')
SHA512=$(parse_field 'sha512')
SERVING_PID=$(parse_field 'servingPid')
REQUEST_UNIT=$(parse_field 'unitName')

if [[ "$SCHEMA" != "2" ]]; then
  reject "unsupported schema version: $SCHEMA"
fi
if [[ -z "$RUNTIME_ID" || -z "$TARGET_VERSION" || -z "$ARTIFACT_PATH" || -z "$SHA512" ]]; then
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
ACTUAL_SHA=$(sha512sum -- "$ARTIFACT_PATH" | awk '{print $1}')
EXPECTED_SHA=$(printf '%s' "$SHA512" | base64 -d 2>/dev/null | sha512sum | awk '{print $1}')
if [[ -z "$EXPECTED_SHA" || "$ACTUAL_SHA" != "$EXPECTED_SHA" ]]; then
  reject "artifact hash mismatch"
fi

if [[ ! -f "$APPIMAGE_TARGET" ]]; then
  reject "current binary missing: $APPIMAGE_TARGET"
fi
if [[ "$ARTIFACT_PATH" -ef "$APPIMAGE_TARGET" ]]; then
  reject "artifact is the live binary"
fi

# From here the app may quit; the helper owns the unit.
write_result '{"phase":"accepted","runtimeId":"'"$RUNTIME_ID"'","targetVersion":"'"$TARGET_VERSION"'"}'
log "accepted request from pid $SERVING_PID for $TARGET_VERSION"

STAGING="$APPIMAGE_TARGET.new"
OLD_VERSION_RECORD=""
if [[ -f "$VERSION_TARGET" ]]; then
  OLD_VERSION_RECORD=$(cat "$VERSION_TARGET")
fi

cleanup_and_fail() {
  set +e
  rm -f "$STAGING"
  log "restarting unit after failure"
  systemctl reset-failed "$UNIT_NAME" 2>/dev/null || true
  systemctl start "$UNIT_NAME" 2>/dev/null || true
  fail "$1"
}

# Stop before touching the binary; the FUSE mount holds the live image.
if ! systemctl stop "$UNIT_NAME"; then
  cleanup_and_fail "could not stop $UNIT_NAME"
fi

# Copy (never mv) onto the target filesystem so a cross-device artifact still lands,
# then fsync + atomic rename. A partial copy can never be promoted.
if ! cp -- "$ARTIFACT_PATH" "$STAGING"; then
  cleanup_and_fail "could not stage artifact"
fi
if ! chmod 0755 "$STAGING"; then
  cleanup_and_fail "could not chmod staged artifact"
fi
if ! chown root:root "$STAGING"; then
  cleanup_and_fail "could not chown staged artifact"
fi
sync -f "$STAGING" 2>/dev/null || sync || true

if ! mv -f "$STAGING" "$APPIMAGE_TARGET"; then
  cleanup_and_fail "could not promote staged artifact"
fi

if ! printf '%s\\n' "$TARGET_VERSION" > "$VERSION_TARGET.tmp"; then
  cleanup_and_fail "could not write version record"
fi
if ! mv -f "$VERSION_TARGET.tmp" "$VERSION_TARGET"; then
  cleanup_and_fail "could not promote version record"
fi

# A tripped StartLimitBurst refuses a plain start.
systemctl reset-failed "$UNIT_NAME" 2>/dev/null || true
if ! systemctl start "$UNIT_NAME"; then
  set +e
  rm -f "$VERSION_TARGET.tmp"
  log "new binary failed to start"
  write_result '{"phase":"failed","reason":"start-failed"}'
  exit 0
fi

write_result '{"phase":"ok","runtimeId":"'"$RUNTIME_ID"'","targetVersion":"'"$TARGET_VERSION"'"}'
log "update to $TARGET_VERSION applied"
`
}
