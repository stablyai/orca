#!/usr/bin/env bash
set -euo pipefail

signal_name=${1:?signal name is required}
app_root=${ORCA_TEST_APP_ROOT:-/artifacts/root}
signal_target_kind=${ORCA_SIGNAL_TARGET:-app}
entrypoint_kind=${ORCA_TEST_ENTRYPOINT:-app}
int_delivery=${ORCA_INT_DELIVERY:-foreground-process-group}
# Packaged Electron startup can approach 90s on a cold CI runner; leave room
# for the readiness line to reach the log before the observer deadline.
startup_timeout_seconds=${ORCA_STARTUP_TIMEOUT_SECONDS:-180}

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
  appimage) entrypoint=(/input/orca.AppImage --appimage-extract-and-run --no-sandbox) ;;
  launcher)
    entrypoint=("$app_root/resources/bin/orca-ide")
    ;;
  *) echo "unsupported entrypoint: $entrypoint_kind" >&2; exit 64 ;;
esac

setsid env -u DISPLAY "${entrypoint[@]}" serve --port 0 --pairing-address 127.0.0.1 --json \
  >"$stdout_log" 2>"$stderr_log" &
app_pid=$!
app_start_ticks=$(awk '{print $22}' "/proc/$app_pid/stat")

# jq's `inputs` waits for EOF even when wrapped in `first`, so a tail -F
# observer can outlive the timeout and leak into the next signal case. Poll
# finite snapshots instead; each parser invocation has a definite EOF.
read_ready_line() {
  sed -u -n 's/^[^{]*//p' "$stdout_log" \
    | jq --unbuffered -Rnc 'first(inputs | fromjson? | select(.type == "orca_server_ready" and .schemaVersion == 1))'
}

ready_line=''
startup_deadline=$((SECONDS + startup_timeout_seconds))
while (( SECONDS < startup_deadline )); do
  ready_line=$(read_ready_line)
  [[ -n "$ready_line" ]] && break
  kill -0 "$app_pid" 2>/dev/null || break
  sleep 1
done
# A readiness event can land as the final poll races the write.
if [[ -z "$ready_line" ]]; then
  ready_line=$(read_ready_line)
fi
if [[ -z "$ready_line" ]]; then
  cat "$stdout_log" "$stderr_log" >&2
  echo "FAIL: entrypoint exited or timed out before orca_server_ready" >&2
  exit 1
fi

registered_cli_verified=false
if [[ "$entrypoint_kind" == appimage ]]; then
  registered_cli="$HOME/.local/bin/orca-ide"
  expected_target="$XDG_CACHE_HOME/orca/appimage/launcher/orca-ide"
  actual_target=$(readlink "$registered_cli" 2>/dev/null || true)
  if [[ "$actual_target" != "$expected_target" ]]; then
    echo "FAIL: registered CLI target is ${actual_target:-missing}; expected $expected_target" >&2
    exit 1
  fi
  if ! registered_help=$("$registered_cli" --help 2>&1) \
    || [[ "$registered_help" != *'Usage: orca <command>'* ]]; then
    echo "FAIL: registered CLI did not execute the packaged help command" >&2
    printf '%s\n' "$registered_help" >&2
    exit 1
  fi
  registered_cli_verified=true
fi

bound_endpoint=$(jq -r '.boundEndpoint' <<<"$ready_line")
bound_port=${bound_endpoint##*:}
listener_before=$(ss -H -ltnp "sport = :$bound_port" || true)
if [[ -z "$listener_before" ]]; then
  echo "FAIL: ready listener has no socket owner at $bound_endpoint" >&2
  exit 1
fi
listener_before_pids=$(grep -oE 'pid=[0-9]+' <<<"$listener_before" | cut -d= -f2 || true)

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
  # The ready socket identifies the serving Electron even when AppImage's
  # extraction wrapper rewrites the command line before it reaches Chromium.
  signal_target_pid=$(head -n1 <<<"$listener_before_pids")
  [[ -n "$signal_target_pid" ]] || { echo "FAIL: serving Electron process not found" >&2; exit 1; }
  if [[ -z "${tree_start_ticks[$signal_target_pid]+present}" ]]; then
    echo "FAIL: ready listener PID $signal_target_pid is outside the entrypoint process tree" >&2
    echo "listener: $listener_before" >&2
    exit 1
  fi
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

# Crashpad can exit just after Electron; poll all owned shutdown state for up to 5s.
for shutdown_poll in {0..50}; do
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
  if [[ -z "$listener_after" && -z "$owned_residue" ]] \
    && ((${#survivors[@]} == 0)); then
    break
  fi
  ((shutdown_poll < 50)) && sleep 0.1
done

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
  --arg listenerBeforePids "$listener_before_pids" \
  --arg listenerAfter "$listener_after" \
  --arg xvfbPids "$xvfb_pids" \
  --arg treeBefore "$tree_snapshot" \
  --argjson waitStatus "$wait_status" \
  --argjson fatalEvidence "$fatal_evidence" \
  --argjson canaryAlive "$canary_alive" \
  --argjson registeredCliVerified "$registered_cli_verified" \
  --arg survivors "${survivors[*]:-}" \
  --arg residue "$owned_residue" \
  --arg corePattern "$(cat /proc/sys/kernel/core_pattern)" \
  '{signal:$signal,signalDelivery:$signalDelivery,entrypointKind:$entrypointKind,signalTargetKind:$signalTargetKind,appPid:$appPid,signalTargetPid:$signalTargetPid,boundEndpoint:$endpoint,listenerBefore:$listenerBefore,listenerBeforePids:$listenerBeforePids,listenerAfter:$listenerAfter,xvfbPids:$xvfbPids,treeBefore:$treeBefore,waitStatus:$waitStatus,fatalEvidence:$fatalEvidence,canaryAlive:$canaryAlive,registeredCliVerified:$registeredCliVerified,survivingTreePids:$survivors,ownedResidue:$residue,corePattern:$corePattern}'

if ((wait_status != 0)) || [[ -n "$listener_after" ]] || [[ "$fatal_evidence" != false ]] \
  || [[ "$canary_alive" != true ]] || ((${#survivors[@]})) || [[ -n "$owned_residue" ]]; then
  echo "--- stdout ---" >&2
  cat "$stdout_log" >&2
  echo "--- stderr ---" >&2
  cat "$stderr_log" >&2
  exit 1
fi
