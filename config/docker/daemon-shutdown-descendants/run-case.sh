#!/bin/sh
set -eu

bundle=${1:?bundle path is required}
mode=${2:?mode is required}
result_dir=/tmp/daemon-shutdown-descendants
mkdir -p "$result_dir"

# The fixture exits like daemon-entry after dispose(). This shell remains as a
# supervisor so a detached descendant can be inspected after the daemon exits.
timeout --kill-after=2s 20s node /opt/daemon-shutdown-descendants/fixture.cjs "$bundle" "$result_dir/fixture.json"

child_pid=$(node -e "const r=require(process.argv[1]); process.stdout.write(String(r.childPid))" "$result_dir/fixture.json")
canary_pid=$(node -e "const r=require(process.argv[1]); process.stdout.write(String(r.canaryPid))" "$result_dir/fixture.json")
shutdown_ms=$(node -e "const r=require(process.argv[1]); process.stdout.write(String(r.shutdownMs))" "$result_dir/fixture.json")

process_state() {
  awk '{ print $3 }' "/proc/$1/stat" 2>/dev/null || true
}

is_live() {
  state=$(process_state "$1")
  test -n "$state" && test "$state" != Z
}

# Observe after the daemon's explicit exit, while the container remains alive.
sleep 1
if is_live "$child_pid"; then
  child_after_exit=live
else
  child_after_exit=gone
fi

if is_live "$canary_pid"; then
  canary_after_exit=live
else
  canary_after_exit=gone
fi

kill -KILL "$child_pid" "$canary_pid" 2>/dev/null || true
printf '%s\n' "{\"mode\":\"$mode\",\"childPid\":$child_pid,\"shutdownMs\":$shutdown_ms,\"childAfterDaemonExit\":\"$child_after_exit\",\"canaryAfterDaemonExit\":\"$canary_after_exit\"}"
test "$shutdown_ms" -lt 5000 || { echo "shutdown exceeded daemon budget" >&2; exit 1; }

case "$mode:$child_after_exit:$canary_after_exit" in
  baseline:live:live|candidate:gone:live) : ;;
  *) echo "unexpected daemon shutdown result" >&2; exit 1 ;;
esac
