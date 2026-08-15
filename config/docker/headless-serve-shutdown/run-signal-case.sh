#!/usr/bin/env bash
set -euo pipefail

signal_name=${1:?signal name is required}
app_root=${ORCA_TEST_APP_ROOT:-/artifacts/root}
signal_target_kind=${ORCA_SIGNAL_TARGET:-app}
entrypoint_kind=${ORCA_TEST_ENTRYPOINT:-app}
int_delivery=${ORCA_INT_DELIVERY:-foreground-process-group}
startup_timeout_seconds=${ORCA_STARTUP_TIMEOUT_SECONDS:-90}

if ((EUID == 0)); then
  exec runuser --user orca --preserve-environment -- "$0" "$@"
fi

case "$signal_name" in
  INT|TERM) ;;
  *) echo "unsupported signal: $signal_name" >&2; exit 64 ;;
esac

state_dir=$(mktemp -d "/tmp/orca-shutdown-${signal_name}.XXXXXX")
stdout_log="$state_dir/stdout.log"
stderr_log="$state_dir/stderr.log"
ulimit -c 0

sleep 300 &
canary_pid=$!
canary_start_ticks=$(awk '{print $22}' "/proc/$canary_pid/stat")
cleanup() {
  kill "$canary_pid" 2>/dev/null || true
  wait "$canary_pid" 2>/dev/null || true
}
trap cleanup EXIT

export HOME="$state_dir/home"
export XDG_CONFIG_HOME="$state_dir/config"
export XDG_CACHE_HOME="$state_dir/cache"
export XDG_RUNTIME_DIR="$state_dir/runtime"
export LIBGL_ALWAYS_SOFTWARE=1
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

case "$entrypoint_kind" in
  app) entrypoint=("$app_root/AppRun" --no-sandbox) ;;
  launcher)
    export ELECTRON_DISABLE_SANDBOX=1
    entrypoint=("$app_root/resources/bin/orca-ide")
    ;;
  *) echo "unsupported entrypoint: $entrypoint_kind" >&2; exit 64 ;;
esac

setsid env -u DISPLAY "${entrypoint[@]}" serve --port 0 --pairing-address 127.0.0.1 --json \
  >"$stdout_log" 2>"$stderr_log" &
app_pid=$!
app_start_ticks=$(awk '{print $22}' "/proc/$app_pid/stat")

# The inner shell expands its positional parameters.
# shellcheck disable=SC2016
ready_line=$(timeout "$startup_timeout_seconds" bash -c '
  tail --pid="$1" -n +1 -F "$2" 2>/dev/null \
    | jq --unbuffered -nc '\''first(inputs | select(.type == "orca_server_ready" and .schemaVersion == 1))'\''
' bash "$app_pid" "$stdout_log" || true)
if [[ -z "$ready_line" ]]; then
  cat "$stdout_log" "$stderr_log" >&2
  echo "FAIL: AppRun exited or timed out before orca_server_ready" >&2
  exit 1
fi

bound_endpoint=$(jq -r '.boundEndpoint' <<<"$ready_line")
bound_port=${bound_endpoint##*:}
listener_before=$(ss -H -ltnp "sport = :$bound_port" || true)
if [[ -z "$listener_before" ]]; then
  echo "FAIL: ready listener has no socket owner at $bound_endpoint" >&2
  exit 1
fi

tree_pids=()
declare -A tree_start_ticks
tree_start_ticks["$app_pid"]=$app_start_ticks
frontier=("$app_pid")
while ((${#frontier[@]})); do
  parent=${frontier[0]}
  frontier=("${frontier[@]:1}")
  while read -r child; do
    [[ -n "$child" ]] || continue
    child_start_ticks=$(awk '{print $22}' "/proc/$child/stat" 2>/dev/null || true)
    [[ -n "$child_start_ticks" ]] || continue
    tree_pids+=("$child")
    tree_start_ticks["$child"]=$child_start_ticks
    frontier+=("$child")
  done < <(ps -o pid= --ppid "$parent" | tr -d ' ')
done

tree_pid_csv="$app_pid"
for pid in "${tree_pids[@]}"; do
  tree_pid_csv+=",$pid"
done
tree_snapshot=$(ps -o pid=,ppid=,pgid=,lstart=,stat=,args= -p "$tree_pid_csv" 2>/dev/null || true)
xvfb_pids=$(awk '/[X]vfb :99 / {print $1}' <<<"$tree_snapshot" | paste -sd, -)
if [[ -z "$xvfb_pids" ]]; then
  echo "$tree_snapshot" >&2
  echo "FAIL: no run-owned Xvfb :99 process found after readiness" >&2
  exit 1
fi

signal_target_pid=$app_pid
if [[ "$signal_target_kind" == serving-electron ]]; then
  signal_target_pid=$(awk '/\/orca-ide .* --serve / {print $1; exit}' <<<"$tree_snapshot")
  [[ -n "$signal_target_pid" ]] || { echo "FAIL: serving Electron process not found" >&2; exit 1; }
elif [[ "$signal_target_kind" != app ]]; then
  echo "unsupported signal target: $signal_target_kind" >&2
  exit 64
fi

signal_target_start_ticks=${tree_start_ticks[$signal_target_pid]:-}
if [[ -z "$signal_target_start_ticks" ]] \
  || [[ $(awk '{print $22}' "/proc/$signal_target_pid/stat") != "$signal_target_start_ticks" ]]; then
  echo "FAIL: signal target identity changed before delivery" >&2
  exit 1
fi
signal_delivery=pid
if [[ "$signal_name" == INT && "$int_delivery" == foreground-process-group ]]; then
  signal_delivery=$int_delivery
  kill -s "$signal_name" -- "-$signal_target_pid"
else
  kill -s "$signal_name" "$signal_target_pid"
fi

sleep 30 &
watchdog_pid=$!
set +e
wait -n -p completed_pid "$app_pid" "$watchdog_pid"
wait_status=$?
set -e
if [[ "$completed_pid" == "$watchdog_pid" ]]; then
  echo "FAIL: foreground AppRun did not exit after $signal_name" >&2
  exit 1
fi
kill "$watchdog_pid" 2>/dev/null || true
wait "$watchdog_pid" 2>/dev/null || true

listener_after=$(ss -H -ltnp "sport = :$bound_port" || true)
survivors=()
for pid in "${tree_pids[@]}"; do
  if [[ -r "/proc/$pid/stat" ]] \
    && [[ $(awk '{print $22}' "/proc/$pid/stat" 2>/dev/null || true) == "${tree_start_ticks[$pid]}" ]] \
    && ps -o stat= -p "$pid" 2>/dev/null | grep -qv '^Z'; then
    survivors+=("$pid")
  fi
done
owned_residue=$(ps -eo pid=,ppid=,stat=,args= | awk -v state="$state_dir" \
  '($0 ~ state || $0 ~ /\/artifacts\/root\/orca-ide/ || $0 ~ /[X]vfb :99 /) && $0 !~ /awk -v state=/ {print}' || true)

canary_alive=false
if kill -0 "$canary_pid" 2>/dev/null \
  && [[ $(awk '{print $22}' "/proc/$canary_pid/stat") == "$canary_start_ticks" ]]; then
  canary_alive=true
fi
fatal_evidence=false
if grep -Eq 'Failed to shutdown|SIGTRAP|Trace/breakpoint trap|core dumped' \
  "$stdout_log" "$stderr_log"; then
  fatal_evidence=true
fi

jq -nc \
  --arg signal "$signal_name" \
  --arg signalDelivery "$signal_delivery" \
  --arg entrypointKind "$entrypoint_kind" \
  --arg signalTargetKind "$signal_target_kind" \
  --argjson appPid "$app_pid" \
  --argjson signalTargetPid "$signal_target_pid" \
  --arg endpoint "$bound_endpoint" \
  --arg listenerBefore "$listener_before" \
  --arg listenerAfter "$listener_after" \
  --arg xvfbPids "$xvfb_pids" \
  --arg treeBefore "$tree_snapshot" \
  --argjson waitStatus "$wait_status" \
  --argjson fatalEvidence "$fatal_evidence" \
  --argjson canaryAlive "$canary_alive" \
  --arg survivors "${survivors[*]:-}" \
  --arg residue "$owned_residue" \
  --arg corePattern "$(cat /proc/sys/kernel/core_pattern)" \
  '{signal:$signal,signalDelivery:$signalDelivery,entrypointKind:$entrypointKind,signalTargetKind:$signalTargetKind,appPid:$appPid,signalTargetPid:$signalTargetPid,boundEndpoint:$endpoint,listenerBefore:$listenerBefore,listenerAfter:$listenerAfter,xvfbPids:$xvfbPids,treeBefore:$treeBefore,waitStatus:$waitStatus,fatalEvidence:$fatalEvidence,canaryAlive:$canaryAlive,survivingTreePids:$survivors,ownedResidue:$residue,corePattern:$corePattern}'

if ((wait_status != 0)) || [[ -n "$listener_after" ]] || [[ "$fatal_evidence" != false ]] \
  || [[ "$canary_alive" != true ]] || ((${#survivors[@]})) || [[ -n "$owned_residue" ]]; then
  echo "--- stdout ---" >&2
  cat "$stdout_log" >&2
  echo "--- stderr ---" >&2
  cat "$stderr_log" >&2
  exit 1
fi
