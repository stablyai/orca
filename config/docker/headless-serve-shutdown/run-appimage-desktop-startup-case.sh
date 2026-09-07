#!/usr/bin/env bash
set -euo pipefail

appimage=${1:-/input/orca.AppImage}
startup_timeout_seconds=90
if [[ $# -gt 1 ]]; then
  echo "usage: run-appimage-desktop-startup-case.sh [appimage]" >&2
  exit 64
fi

if ((EUID == 0)); then
  if ! state_dir=$(mktemp -d /tmp/orca-appimage-startup.XXXXXX); then
    echo 'FAIL: unable to create the AppImage startup state directory' >&2
    exit 1
  fi
  if ! chown orca:orca "$state_dir"; then
    echo "FAIL: unable to hand the AppImage startup state directory to orca: $state_dir" >&2
    rm -rf -- "$state_dir" || true
    exit 1
  fi
  exec runuser --user orca --preserve-environment -- env \
    ORCA_STARTUP_STATE_DIR="$state_dir" \
    ORCA_STARTUP_STATE_DIR_CLEANUP=1 \
    "$0" "$@"
fi

remove_state_dir_on_exit=${ORCA_STARTUP_STATE_DIR_CLEANUP:-0}
if [[ -n "${ORCA_STARTUP_STATE_DIR:-}" ]]; then
  state_dir=$ORCA_STARTUP_STATE_DIR
else
  if ! state_dir=$(mktemp -d /tmp/orca-appimage-startup.XXXXXX); then
    echo 'FAIL: unable to create the AppImage startup state directory' >&2
    exit 1
  fi
  remove_state_dir_on_exit=1
fi
stdout_log="$state_dir/stdout.log"
stderr_log="$state_dir/stderr.log"
launcher_pid=
launcher_start_ticks=
launcher_pgid=
launcher_status=
launcher_waited=false
tree_pids=()
declare -A tree_start_ticks=()

read_start_ticks() {
  local pid=$1
  [[ -r "/proc/$pid/stat" ]] || return 1
  awk '{print $22}' "/proc/$pid/stat"
}

identity_alive() {
  local pid=$1
  local expected_ticks=$2
  [[ -n "$expected_ticks" ]] || return 1
  [[ -r "/proc/$pid/stat" ]] || return 1
  [[ $(awk '{print $22}' "/proc/$pid/stat" 2>/dev/null || true) == "$expected_ticks" ]] || return 1
  local process_state
  process_state=$(ps -o stat= -p "$pid" 2>/dev/null | tr -d '[:space:]' || true)
  [[ -n "$process_state" && "$process_state" != Z* ]]
}

collect_process_tree() {
  tree_pids=()
  tree_start_ticks=()
  [[ -n "$launcher_pid" ]] || return
  [[ -n "$launcher_start_ticks" ]] || return
  tree_pids+=("$launcher_pid")
  tree_start_ticks["$launcher_pid"]="$launcher_start_ticks"
  local -a frontier=("$launcher_pid")
  while ((${#frontier[@]})); do
    local parent=${frontier[0]}
    frontier=("${frontier[@]:1}")
    while read -r child; do
      [[ -n "$child" ]] || continue
      [[ -z "${tree_start_ticks[$child]+present}" ]] || continue
      local child_ticks
      child_ticks=$(read_start_ticks "$child" 2>/dev/null || true)
      [[ -n "$child_ticks" ]] || continue
      tree_pids+=("$child")
      tree_start_ticks["$child"]="$child_ticks"
      frontier+=("$child")
    done < <(ps -eo pid=,ppid= | awk -v parent="$parent" '$2 == parent {print $1}')
  done
}

process_is_xvfb() {
  local pid=$1
  local command_name
  command_name=$(ps -o comm= -p "$pid" 2>/dev/null || true)
  [[ "$command_name" == Xvfb ]] && return 0
  local command_line
  command_line=$(ps -o args= -p "$pid" 2>/dev/null || true)
  [[ "$command_line" =~ (^|[[:space:]/])Xvfb([[:space:]]|$) ]]
}

signal_process_group() {
  local signal=$1
  identity_alive "$launcher_pid" "$launcher_start_ticks" || return 0
  [[ "$launcher_pgid" =~ ^[0-9]+$ ]] || return 0
  [[ "$launcher_pgid" != "$(ps -o pgid= -p "$$" | tr -d ' ')" ]] || return 0
  kill -s "$signal" -- "-$launcher_pgid" 2>/dev/null || true
}

signal_owned_processes() {
  local signal=$1
  local index pid ticks
  for ((index = ${#tree_pids[@]} - 1; index >= 0; index--)); do
    pid=${tree_pids[index]}
    ticks=${tree_start_ticks[$pid]-}
    if identity_alive "$pid" "$ticks"; then
      kill -s "$signal" "$pid" 2>/dev/null || true
    fi
  done
}

wait_for_owned_exit() {
  local timeout_seconds=$1
  local deadline=$((SECONDS + timeout_seconds))
  local pid ticks alive
  while ((SECONDS < deadline)); do
    alive=0
    for pid in "${tree_pids[@]}"; do
      ticks=${tree_start_ticks[$pid]-}
      if identity_alive "$pid" "$ticks"; then
        alive=1
        break
      fi
    done
    if ((alive == 0)); then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

dump_logs() {
  echo "--- desktop startup stdout ---" >&2
  cat "$stdout_log" >&2 2>/dev/null || true
  echo "--- desktop startup stderr ---" >&2
  cat "$stderr_log" >&2 2>/dev/null || true
}

cleanup_state_dir() {
  [[ "$remove_state_dir_on_exit" == 1 ]] || return 0
  [[ "$state_dir" =~ ^/tmp/orca-appimage-startup\.[^/]+$ ]] || return 0
  [[ -d "$state_dir" && ! -L "$state_dir" && -O "$state_dir" ]] || return 0
  rm -rf -- "$state_dir"
}

capture_launcher_status() {
  [[ "$launcher_waited" == false ]] || return 0
  [[ -n "$launcher_pid" ]] || return 1
  if wait "$launcher_pid"; then
    launcher_status=0
  else
    launcher_status=$?
  fi
  launcher_waited=true
}

report_launcher_exit() {
  local reason=$1
  local observed_status=unknown
  local exit_status=1
  if capture_launcher_status; then
    observed_status=$launcher_status
    if ((launcher_status != 0)); then
      exit_status=$launcher_status
    fi
  fi
  echo "FAIL: desktop launcher exited before ${reason} (status=${observed_status})" >&2
  exit "$exit_status"
}

cleanup() {
  local status=$?
  trap - EXIT
  signal_process_group TERM || true
  signal_owned_processes TERM || true
  if ! wait_for_owned_exit 10; then
    signal_process_group KILL || true
    signal_owned_processes KILL || true
    wait_for_owned_exit 5 || status=1
  fi
  capture_launcher_status || true
  if ((status != 0)); then
    dump_logs
  else
    if ! cleanup_state_dir; then
      status=1
      dump_logs
    fi
  fi
  exit "$status"
}
trap cleanup EXIT

mkdir -p "$state_dir/home" "$state_dir/config" "$state_dir/cache" "$state_dir/runtime"
chmod 700 "$state_dir/runtime"
export HOME="$state_dir/home"
export XDG_CONFIG_HOME="$state_dir/config"
export XDG_CACHE_HOME="$state_dir/cache"
export XDG_RUNTIME_DIR="$state_dir/runtime"
export LIBGL_ALWAYS_SOFTWARE=1
export ORCA_STARTUP_DIAGNOSTICS=1
ulimit -c 0

[[ -r "$appimage" ]] || { echo "FAIL: AppImage is not readable: $appimage" >&2; exit 1; }
[[ -x "$appimage" ]] || { echo "FAIL: AppImage is not executable: $appimage" >&2; exit 1; }

setsid --wait dbus-run-session -- xvfb-run -a "$appimage" --appimage-extract-and-run --no-sandbox \
  >"$stdout_log" 2>"$stderr_log" &
launcher_pid=$!
launcher_start_ticks=$(read_start_ticks "$launcher_pid" 2>/dev/null || true)
launcher_pgid=$(ps -o pgid= -p "$launcher_pid" 2>/dev/null | tr -d ' ' || true)
if [[ -z "$launcher_start_ticks" ]]; then
  report_launcher_exit 'its identity could be recorded'
fi

marker_seen=false
deadline=$((SECONDS + startup_timeout_seconds))
while ((SECONDS < deadline)); do
  if grep -Eq '^\[startup\] updater-setup-done t=[0-9]+$' "$stderr_log"; then
    marker_seen=true
    break
  fi
  if ! identity_alive "$launcher_pid" "$launcher_start_ticks"; then
    report_launcher_exit 'the updater-setup-done marker'
  fi
  sleep 0.2
done
if [[ "$marker_seen" != true ]]; then
  if ! identity_alive "$launcher_pid" "$launcher_start_ticks"; then
    report_launcher_exit 'the updater-setup-done marker'
  fi
  echo "FAIL: desktop AppImage did not emit updater-setup-done within ${startup_timeout_seconds}s" >&2
  exit 1
fi
if ! identity_alive "$launcher_pid" "$launcher_start_ticks"; then
  echo "FAIL: desktop launcher identity changed after startup marker" >&2
  exit 1
fi

collect_process_tree
xvfb_pids=()
for pid in "${tree_pids[@]}"; do
  if process_is_xvfb "$pid"; then
    xvfb_pids+=("$pid")
  fi
done
if ((${#xvfb_pids[@]} == 0)); then
  echo "FAIL: no launcher-owned Xvfb process was found after startup" >&2
  exit 1
fi
for pid in "${xvfb_pids[@]}"; do
  if ! identity_alive "$pid" "${tree_start_ticks[$pid]-}"; then
    echo "FAIL: launcher-owned Xvfb identity changed before cleanup" >&2
    exit 1
  fi
done

echo "Desktop AppImage startup validation passed (launcher=${launcher_pid}, xvfb=${xvfb_pids[*]})."
