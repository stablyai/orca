#!/usr/bin/env bash
# test-logging-setup.sh — verify install-logging-setup.sh WITHOUT touching production.
#
# Sandbox-installs to a temp dir (overriding every destination under $TMP), then
# checks rendering, validity, and idempotency. Requires a sudo-capable user and a
# Linux/systemd host:
#
#     bash test-logging-setup.sh
#
# Exit 0 = all checks pass; non-zero = at least one check failed.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALLER="$HERE/install-logging-setup.sh"
TMP="$(mktemp -d /tmp/orca-serve-test.XXXXXX)"
# The installer chowns the state tree to svc_orca:revive and logrotate's `su`
# directive re-enters that account, so the sandbox root must stay traversable.
chmod 0755 "$TMP"
trap 'sudo rm -rf "$TMP"' EXIT

PREFIX="$TMP/prefix"; SYSD="$TMP/systemd"; LR="$TMP/logrotate.d"; JD="$TMP/journald.conf.d"
PASS=0; FAIL=0
ok()  { printf 'PASS  %s\n' "$*"; PASS=$((PASS+1)); }
bad() { printf 'FAIL  %s\n' "$*"; FAIL=$((FAIL+1)); }

echo "== test-logging-setup (sandbox: $TMP) =="

# 1. syntax
if bash -n "$INSTALLER"; then ok "bash -n"; else bad "bash -n"; fi

# 2. dry-run audit (default dirs, read-only)
if sudo bash "$INSTALLER" --dry-run >/dev/null 2>&1; then ok "--dry-run audit"; else bad "--dry-run audit"; fi

# 3. sandbox install — NO pre-created dirs (proves SYSTEMD_DIR is mkdir'd)
if sudo env INSTALL_PREFIX="$PREFIX" SYSTEMD_DIR="$SYSD" LOGROTATE_DIR="$LR" JOURNALD_DIR="$JD" \
     bash "$INSTALLER" --slot test >/dev/null 2>&1; then
  ok "sandbox install (no pre-created dirs)"
else
  bad "sandbox install (no pre-created dirs)"
fi

# 4. every installed artifact is placeholder-free
missing=""; leftover=""
for f in "$SYSD/orca-serve@.service" "$PREFIX/etc/orca-serve.conf" "$PREFIX/etc/instances/test.env" "$LR/orca-serve" "$JD/orca-serve.conf"; do
  if [ ! -f "$f" ]; then missing="$missing $f"; continue; fi
  if grep -Eq '@PREFIX@' "$f"; then leftover="$leftover $f"; fi
done
if [ -z "$missing" ]; then ok "all expected artifacts present"; else bad "missing artifacts:$missing"; fi
if [ -z "$leftover" ]; then ok "no leftover @PREFIX@ placeholders"; else bad "leftover placeholders:$leftover"; fi

# 5. idempotency — re-run reports 'keep (already present)'
# (grep without -q: -q exits early and SIGPIPEs the installer under pipefail)
if sudo env INSTALL_PREFIX="$PREFIX" SYSTEMD_DIR="$SYSD" LOGROTATE_DIR="$LR" JOURNALD_DIR="$JD" \
     bash "$INSTALLER" --slot test 2>&1 | grep 'keep (already present)' >/dev/null; then
  ok "idempotency (keep already present)"
else
  bad "idempotency (keep already present)"
fi

# 6. logrotate validity (needs root: the `su svc_orca` directive re-enters the account)
if sudo logrotate -d "$LR/orca-serve" >/dev/null 2>&1; then
  ok "logrotate -d"
else
  bad "logrotate -d"
fi

# 7. systemd-analyze verify (stub the orca-serve-fg binary the installer intentionally omits)
sudo mkdir -p "$PREFIX/bin"
printf '#!/bin/sh\nexit 0\n' | sudo tee "$PREFIX/bin/orca-serve-fg" >/dev/null
sudo chmod +x "$PREFIX/bin/orca-serve-fg"
if systemd-analyze verify "$SYSD/orca-serve@.service" >/dev/null 2>&1; then
  ok "systemd-analyze verify"
else
  bad "systemd-analyze verify"
fi

# 8. UNIT OWNERSHIP GUARD — the installer must never rewrite an existing,
# DIFFERING orca-serve@.service. That file is a template unit: one copy backs
# every slot on the host (factory/canary/lesley/jessica), so a silent rewrite
# re-points them all at once. scripts/install.sh owns unit deployment.
UNIT="$SYSD/orca-serve@.service"
unit_sha() { sha256sum "$UNIT" | cut -d' ' -f1; }
sudo sed -i 's/^Description=.*/Description=HAND-EDITED locally — must not be clobbered/' "$UNIT"
drift_sha="$(unit_sha)"

out="$(sudo env INSTALL_PREFIX="$PREFIX" SYSTEMD_DIR="$SYSD" LOGROTATE_DIR="$LR" JOURNALD_DIR="$JD" \
        bash "$INSTALLER" --slot test 2>&1)"; rc=$?
if [ "$rc" -eq 3 ] && [ "$(unit_sha)" = "$drift_sha" ]; then
  ok "drifted unit refused (exit 3) and left byte-identical"
else
  bad "drifted unit not protected (exit $rc, sha changed: $([ "$(unit_sha)" = "$drift_sha" ] && echo no || echo YES))"
fi
case "$out" in
  *"unit outcome=REFUSED"*) ok "refusal reports the outcome and the drift diff" ;;
  *)                        bad "refusal did not report 'unit outcome=REFUSED'" ;;
esac

# 9. --dry-run must report the outcome it WOULD take, and still change nothing
out="$(sudo env INSTALL_PREFIX="$PREFIX" SYSTEMD_DIR="$SYSD" LOGROTATE_DIR="$LR" JOURNALD_DIR="$JD" \
        bash "$INSTALLER" --slot test --dry-run 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && [ "$(unit_sha)" = "$drift_sha" ]; then
  case "$out" in
    *would-refuse*) ok "--dry-run reports outcome=would-refuse on drift" ;;
    *)              bad "--dry-run did not report the would-refuse outcome" ;;
  esac
else
  bad "--dry-run on drift changed state or exited non-zero (exit $rc)"
fi

# 10. --force-unit is the explicit opt-in: overwrite, keeping a .bak-<UTC> copy.
# "sha changed" alone would also be satisfied by writing garbage, so the
# overwritten bytes are pinned to the render via the installer's own comparison:
# a follow-up run with NO --force-unit must report outcome=unchanged, which is
# only reachable through files_identical "$UNIT_DEST" "<render>".
out="$(sudo env INSTALL_PREFIX="$PREFIX" SYSTEMD_DIR="$SYSD" LOGROTATE_DIR="$LR" JOURNALD_DIR="$JD" \
        bash "$INSTALLER" --slot test --force-unit 2>&1)"; rc=$?
bak="$(ls "$SYSD"/orca-serve@.service.bak-* 2>/dev/null | head -1)"
confirm="$(sudo env INSTALL_PREFIX="$PREFIX" SYSTEMD_DIR="$SYSD" LOGROTATE_DIR="$LR" JOURNALD_DIR="$JD" \
        bash "$INSTALLER" --slot test 2>&1)"; confirm_rc=$?
case "$confirm" in *"unit outcome=unchanged"*) is_render=0 ;; *) is_render=1 ;; esac
if [ "$rc" -eq 0 ] && [ "$(unit_sha)" != "$drift_sha" ] \
   && [ "$confirm_rc" -eq 0 ] && [ "$is_render" -eq 0 ]; then
  ok "--force-unit overwrote the drifted unit with the render (re-run: outcome=unchanged)"
else
  bad "--force-unit did not overwrite with the render (exit $rc, re-run exit $confirm_rc, outcome=unchanged: $([ "$is_render" -eq 0 ] && echo yes || echo NO))"
fi
if [ -n "$bak" ] && [ "$(sha256sum "$bak" | cut -d' ' -f1)" = "$drift_sha" ]; then
  ok "--force-unit kept a timestamped backup of the pre-overwrite bytes ($(basename "$bak"))"
else
  bad "--force-unit left no faithful .bak-<UTC> backup"
fi

echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
