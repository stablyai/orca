#!/usr/bin/env bash
# E2E case for the Linux serve auto-update flow inside a systemd container.
# Runs the full handshake: spool request -> root helper -> swap -> VERSION ->
# restart -> journal readiness -> result.json verdict.
set -euo pipefail

APPIMAGE=/input/orca-update.AppImage
SPOOL_DIR=/var/lib/orca-server-update
UNIT_NAME=orca-serve.service
APPIMAGE_TARGET=/opt/orca/orca-linux.AppImage
VERSION_TARGET=/opt/orca/VERSION
SERVICE_USER=orca
READY_TIMEOUT=${ORCA_READINESS_TIMEOUT:-60}
UPDATE_TIMEOUT=${ORCA_UPDATE_TIMEOUT:-180}

fail() { echo "FAIL: $*" >&2; exit 1; }
log() { echo "[update-case] $*"; }

(( EUID == 0 )) || fail "must run as root (systemd PID 1)"

# --- 1. Fake installed app ---------------------------------------------------
install -d -m 0755 /opt/orca
install -m 0755 "$APPIMAGE" "$APPIMAGE_TARGET"
printf '0.0.0-test-old\n' > "$VERSION_TARGET"
chown -R root:root /opt/orca

# --- 2. Fake update feed -----------------------------------------------------
# The "new" artifact is the same AppImage; the helper's version gate is the
# VERSION record, not the AppImage content, so reuse is safe.
install -d -m 0755 /srv/feed
cp "$APPIMAGE" /srv/feed/orca-linux-1.AppImage
sha=$(sha512sum /srv/feed/orca-linux-1.AppImage | awk '{print $1}')
b64=$(printf '%s' "$sha" | base64 -w0)
cat > /srv/feed/latest-linux.yml <<EOF
version: 1.2.3-test
files:
  - url: orca-linux-1.AppImage
    sha512: $b64
    size: $(stat -c %s /srv/feed/orca-linux-1.AppImage)
path: orca-linux-1.AppImage
releaseDate: '2026-01-01T00:00:00.000Z'
releaseName: '1.2.3-test'
EOF

python3 /usr/local/bin/mock-feed.py --port 8123 --root /srv/feed &
feed_pid=$!
trap 'kill $feed_pid 2>/dev/null || true' EXIT

# --- 3. Unit with --json so the helper can verify readiness via journal ------
cat > /etc/systemd/system/orca-serve.service <<EOF
[Unit]
Description=Orca runtime server (test)
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
User=$SERVICE_USER
Environment=LIBGL_ALWAYS_SOFTWARE=1
ExecStart=$APPIMAGE_TARGET serve --json
StandardOutput=journal
StandardError=journal
KillMode=mixed
Restart=on-failure
RestartPreventExitStatus=3
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl start "$UNIT_NAME"

# --- 4. Install the helper ---------------------------------------------------
cat > /tmp/helper-install.sh <<'INSTALL_EOF'
__HELPER_INSTALL_SCRIPT__
INSTALL_EOF
bash /tmp/helper-install.sh

# --- 5. Spool a request the way the app does ---------------------------------
install -d -m 0775 -o root -g "$SERVICE_USER" "$SPOOL_DIR"
cat > "$SPOOL_DIR/request.json" <<EOF
{"schemaVersion":2,"runtimeId":"e2e-runtime-1","fromVersion":"0.0.0-test-old","targetVersion":"1.2.3-test","artifactPath":"/srv/feed/orca-linux-1.AppImage","sha512":"$b64","servingPid":1,"unitName":"$UNIT_NAME"}
EOF
chown root:"$SERVICE_USER" "$SPOOL_DIR/request.json"
chmod 0664 "$SPOOL_DIR/request.json"

# --- 6. Run the helper as the service user via sudo --------------------------
old_main_pid=$(systemctl show -p MainPID --value "$UNIT_NAME")
[[ -n "$old_main_pid" && "$old_main_pid" != 0 ]] || fail "unit not running before helper run"
sudo -n -u "$SERVICE_USER" "$HELPER_PATH"

verdict=$(cat "$SPOOL_DIR/result.json")
log "verdict: $verdict"
[[ $(jq -r '.phase' <<<"$verdict") == "ok" ]] || fail "expected phase=ok, got: $verdict"
[[ $(jq -r '.targetVersion' <<<"$verdict") == "1.2.3-test" ]] || fail "wrong targetVersion"
[[ ! -f "$SPOOL_DIR/request.json" ]] || fail "request.json was not consumed"

# --- 7. Assert the swap actually happened ------------------------------------
[[ $(cat "$VERSION_TARGET") == "1.2.3-test" ]] || fail "VERSION not updated: $(cat "$VERSION_TARGET")"
new_main_pid=$(systemctl show -p MainPID --value "$UNIT_NAME")
[[ -n "$new_main_pid" && "$new_main_pid" != 0 ]] || fail "unit not running after update"
[[ "$new_main_pid" != "$old_main_pid" ]] || fail "MainPID unchanged after update"
[[ ! -f "$APPIMAGE_TARGET.update-backup" ]] || fail "rollback snapshot left behind"

# --- 8. Negative case: downgrade must be rejected ----------------------------
cat > "$SPOOL_DIR/request.json" <<EOF
{"schemaVersion":2,"runtimeId":"e2e-runtime-2","fromVersion":"1.2.3-test","targetVersion":"0.0.0-test-old","artifactPath":"/srv/feed/orca-linux-1.AppImage","sha512":"$b64","servingPid":1,"unitName":"$UNIT_NAME"}
EOF
chown root:"$SERVICE_USER" "$SPOOL_DIR/request.json"
chmod 0664 "$SPOOL_DIR/request.json"
rm -f "$SPOOL_DIR/result.json"
sudo -n -u "$SERVICE_USER" "$HELPER_PATH"
downgrade_verdict=$(cat "$SPOOL_DIR/result.json")
[[ $(jq -r '.phase' <<<"$downgrade_verdict") == "rejected" ]] || fail "downgrade not rejected: $downgrade_verdict"
[[ $(jq -r '.reason' <<<"$downgrade_verdict") == *"downgrade"* ]] || fail "unexpected downgrade reason"
[[ ! -f "$SPOOL_DIR/request.json" ]] || fail "request.json survived a rejected downgrade"
[[ $(cat "$VERSION_TARGET") == "1.2.3-test" ]] || fail "downgrade mutated VERSION"
[[ $(systemctl is-active "$UNIT_NAME") == "active" ]] || fail "downgrade case left unit down"

log "all assertions passed"
