#!/usr/bin/env bash
# Entrypoint for the "full" server image: start a virtual X display so the
# offscreen browser backend can initialize Chromium, then launch the server.
# The pure-API "slim" image needs none of this.
set -euo pipefail

DISPLAY_NUM="${DISPLAY:-:99}"
Xvfb "${DISPLAY_NUM}" -screen 0 1280x1024x24 -nolisten tcp &
XVFB_PID=$!

cleanup() {
  kill "${XVFB_PID}" 2>/dev/null || true
}
trap cleanup EXIT TERM INT

# Give Xvfb a moment to create its socket before the server boots.
for _ in $(seq 1 50); do
  [ -S "/tmp/.X11-unix/X${DISPLAY_NUM#:}" ] && break
  sleep 0.1
done

exec orca-ide serve --port "${ORCA_SERVE_PORT:-6768}" --json "$@"
