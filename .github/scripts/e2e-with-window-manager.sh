#!/usr/bin/env bash
set -euo pipefail
openbox --sm-disable > /tmp/orca-e2e-window-manager.log 2>&1 &
wm_pid=$!
cleanup() {
  kill "$wm_pid" 2>/dev/null || true
  wait "$wm_pid" 2>/dev/null || true
}
trap cleanup EXIT
ready=false
for attempt in {1..100}; do
  if xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | rg -q 'window id # 0x[1-9a-fA-F]'; then
    ready=true
    break
  fi
  if ! kill -0 "$wm_pid" 2>/dev/null; then
    cat /tmp/orca-e2e-window-manager.log
    exit 1
  fi
  sleep 0.1
done
if [ "$ready" != true ]; then
  echo 'Window manager did not acquire the Xvfb root window' >&2
  exit 1
fi
"$@"
