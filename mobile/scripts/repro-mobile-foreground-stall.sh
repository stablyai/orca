#!/usr/bin/env bash
# Reproduce iOS 0.0.39(2)’s foreground “Connecting…” stall. Simulator does not suspend JS:
# SIGSTOP the app to freeze timers/leave its socket dangling; SIGSTOP desktop to accept TCP
# without WebSocket upgrades, like a wedged tunnel/relay. Use simctl because Orca’s runtime is frozen.
# Setup: node scripts/start-emulator.mjs --device "iPhone 17 Pro" --wait-for-ready > /tmp/orca-emulator-boot.log 2>&1 &
# Usage: repro-mobile-foreground-stall.sh <udid> <paired-host-port> [log]
set -euo pipefail

UDID="${1:?simulator udid}"
PORT="${2:?port of the paired host, from the [net] logs}"
LOG="${3:-/tmp/orca-emulator-boot.log}"
BUNDLE_ID=com.stably.orca.mobile
# Long enough for the tiered backoff to reach its 30s/60s tail.
ESCALATE_SECONDS=200

APP=$(pgrep -f "CoreSimulator.*Orca.app/Orca" | head -1)
DESK=$(pgrep -f "serve-mobile-pairing" | head -1)
: "${APP:?mobile app is not running in the simulator}"
: "${DESK:?headless desktop runtime is not running}"

strip() { sed 's/\x1b\[[0-9;]*m//g'; }
since() { sed -n "$(( $1 + 1 )),\$p" "$LOG" | strip; }
step() { echo "$(date +%T) $*"; }

echo "### app=$APP desktop=$DESK port=$PORT"

step "[1] desktop goes unreachable"
kill -STOP "$DESK"
sleep "$ESCALATE_SECONDS"
step "[2] backoff at $(since 0 | grep "$PORT" | grep -o '"attempt": [0-9]*' | tail -1)"

MARK=$(wc -l < "$LOG")
while true; do
  since "$MARK" | grep "$PORT" | grep -q '"to": "connecting"' && break
  sleep 0.3
done
step "[3] connect window open — user switches away"
xcrun simctl launch "$UDID" com.apple.mobilesafari >/dev/null 2>&1
sleep 1
kill -STOP "$APP"
step "[4] phone suspended mid-dial"
sleep 5

MARK=$(wc -l < "$LOG")
kill -CONT "$APP"
sleep 0.3
xcrun simctl launch "$UDID" "$BUNDLE_ID" >/dev/null 2>&1
T0=$(date +%s)
step "[5] user returns to Orca  <-- t0, desktop still down"

# Keep desktop unreachable to test whether foregrounding abandons the dead dial immediately.
sleep 6
echo "--- first 6s after t0 ---"
since "$MARK" | grep -E "$PORT|foreground" \
  | grep -E 'state |foreground|scheduleReconnect|openConnection' | head -8

kill -CONT "$DESK"
step "[6] desktop healthy again"
for _ in $(seq 1 45); do
  if since "$MARK" | grep "$PORT" | grep -q '"to": "connected"'; then
    step ">>> connected $(( $(date +%s) - T0 ))s after t0"
    exit 0
  fi
  sleep 2
done
step ">>> STILL STUCK 90s after t0"
exit 1
