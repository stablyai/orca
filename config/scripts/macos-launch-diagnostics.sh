#!/usr/bin/env bash
# Capture one-shot macOS launch diagnostics for a published Orca release.
#
# Usage:
#   ORCA_DIAGNOSTIC_TAG=v1.4.42-rc.1 bash config/scripts/macos-launch-diagnostics.sh
#   bash config/scripts/macos-launch-diagnostics.sh --tag v1.4.42-rc.1
set -euo pipefail

REPO="${ORCA_DIAGNOSTIC_REPO:-stablyai/orca}"
TAG="${ORCA_DIAGNOSTIC_TAG:-}"
KEEP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag)
      TAG="${2:-}"
      shift 2
      ;;
    --repo)
      REPO="${2:-}"
      shift 2
      ;;
    --keep)
      KEEP=1
      shift
      ;;
    -h|--help)
      cat <<'EOF'
Capture one-shot macOS launch diagnostics for a published Orca release.

Usage:
  ORCA_DIAGNOSTIC_TAG=v1.4.42-rc.1 bash config/scripts/macos-launch-diagnostics.sh
  bash config/scripts/macos-launch-diagnostics.sh --tag v1.4.42-rc.1
EOF
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Usage: $0 --tag vX.Y.Z-rc.N [--repo owner/repo] [--keep]" >&2
      exit 2
      ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This diagnostic script only supports macOS." >&2
  exit 2
fi

if [[ -z "$TAG" ]]; then
  echo "Set ORCA_DIAGNOSTIC_TAG or pass --tag vX.Y.Z-rc.N." >&2
  exit 2
fi

ARCH="$(uname -m)"
case "$ARCH" in
  arm64) ASSET="orca-macos-arm64.dmg" ;;
  x86_64) ASSET="orca-macos-x64.dmg" ;;
  *)
    echo "Unsupported macOS architecture: $ARCH" >&2
    exit 2
    ;;
esac

TIMESTAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/orca-launch-diagnostics.XXXXXXXX")"
OUT_DIR="$WORK_DIR/output"
MOUNT_DIR="$WORK_DIR/mount"
APP_DIR="$WORK_DIR/Orca.app"
DMG_PATH="$WORK_DIR/$ASSET"
mkdir -p "$OUT_DIR" "$MOUNT_DIR"

if [[ -d "$HOME/Desktop" ]]; then
  ZIP_PATH="$HOME/Desktop/orca-launch-diagnostics-${TAG}-${TIMESTAMP}.zip"
else
  ZIP_PATH="$PWD/orca-launch-diagnostics-${TAG}-${TIMESTAMP}.zip"
fi

diag_log() {
  printf '[orca-diagnostics] %s\n' "$*"
}

run_capture() {
  local name="$1"
  shift
  {
    echo "\$ $*"
    "$@"
  } >"$OUT_DIR/$name.out" 2>"$OUT_DIR/$name.err" || {
    local code=$?
    echo "exit=$code" >>"$OUT_DIR/$name.err"
    return 0
  }
}

cleanup() {
  if mount | grep -F " on $MOUNT_DIR " >/dev/null 2>&1; then
    hdiutil detach "$MOUNT_DIR" -quiet >/dev/null 2>&1 || true
  fi
  if [[ "$KEEP" -eq 0 ]]; then
    rm -rf "$WORK_DIR"
  else
    diag_log "kept working directory: $WORK_DIR"
  fi
}
trap cleanup EXIT

write_environment_report() {
  {
    echo "tag=$TAG"
    echo "repo=$REPO"
    echo "asset=$ASSET"
    echo "timestamp_utc=$TIMESTAMP"
    echo
    echo "## sw_vers"
    sw_vers || true
    echo
    echo "## uname"
    uname -a || true
    echo
    echo "## shell"
    echo "$SHELL"
    echo
    echo "## current Orca processes before diagnostics"
    pgrep -fl 'Orca|orca' || true
  } >"$OUT_DIR/environment.txt"
}

ensure_no_existing_orca() {
  local existing
  existing="$(pgrep -x Orca || true)"
  if [[ -z "$existing" ]]; then
    return 0
  fi

  {
    echo "An Orca process is already running. Close Orca and run this script again."
    echo
    ps -p "$(printf '%s' "$existing" | paste -sd, -)" -o pid=,ppid=,command= || true
  } | tee "$OUT_DIR/existing-orca-process.txt" >&2
  exit 2
}

download_and_copy_app() {
  local url="https://github.com/$REPO/releases/download/$TAG/$ASSET"
  diag_log "downloading $url"
  curl -fL --retry 3 --retry-delay 2 -o "$DMG_PATH" "$url"
  shasum -a 256 "$DMG_PATH" >"$OUT_DIR/dmg.sha256" || true

  diag_log "mounting DMG"
  hdiutil attach "$DMG_PATH" -nobrowse -readonly -mountpoint "$MOUNT_DIR" >"$OUT_DIR/hdiutil-attach.txt"
  local source_app
  source_app="$(find "$MOUNT_DIR" -maxdepth 1 -name '*.app' -type d | head -n 1)"
  if [[ -z "$source_app" ]]; then
    echo "No .app bundle found in $DMG_PATH" >&2
    exit 1
  fi

  diag_log "copying app to isolated temp path"
  ditto "$source_app" "$APP_DIR"
  hdiutil detach "$MOUNT_DIR" -quiet
}

write_app_report() {
  {
    echo "app=$APP_DIR"
    echo
    echo "## Info.plist"
    plutil -p "$APP_DIR/Contents/Info.plist" || true
    echo
    echo "## spctl"
    spctl -a -vvv "$APP_DIR" || true
    echo
    echo "## codesign display"
    codesign -dv --verbose=4 "$APP_DIR" || true
    echo
    echo "## codesign verify"
    codesign --verify --strict --deep "$APP_DIR" || true
    echo
    echo "## xattr"
    xattr -lr "$APP_DIR" || true
    echo
    echo "## native modules"
    find "$APP_DIR/Contents/Resources" -name '*.node' -print || true
  } >"$OUT_DIR/app-report.txt" 2>&1
}

start_log_stream() {
  local file="$1"
  local predicate='process == "Orca" OR eventMessage CONTAINS[c] "Orca" OR eventMessage CONTAINS[c] "com.stablyai.orca"'
  if command -v log >/dev/null 2>&1; then
    command log stream --style compact --predicate "$predicate" >"$file" 2>&1 &
    echo "$!"
  else
    echo ""
  fi
}

stop_log_stream() {
  local pid="$1"
  if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
    kill "$pid" >/dev/null 2>&1 || true
    wait "$pid" >/dev/null 2>&1 || true
  fi
}

latest_orca_pid_for_app() {
  pgrep -nf "$APP_DIR/Contents/MacOS/Orca" || true
}

sample_process_once() {
  local pid="$1"
  local file="$2"
  if [[ -n "$pid" ]] && command -v sample >/dev/null 2>&1; then
    sample "$pid" 1 -file "$file" >"$file.command.out" 2>"$file.command.err" || true
  fi
}

terminate_app_processes() {
  local pid
  pid="$(latest_orca_pid_for_app)"
  if [[ -n "$pid" ]]; then
    kill "$pid" >/dev/null 2>&1 || true
    sleep 1
    if kill -0 "$pid" >/dev/null 2>&1; then
      kill -9 "$pid" >/dev/null 2>&1 || true
    fi
  fi
}

wait_for_probe() {
  local runner_pid="$1"
  local label="$2"
  local sample_file="$OUT_DIR/$label.sample.txt"
  local sampled=0
  local i

  for i in $(seq 1 200); do
    local app_pid
    app_pid="$(latest_orca_pid_for_app)"
    if [[ "$sampled" -eq 0 && -n "$app_pid" ]]; then
      sampled=1
      echo "sampled_pid=$app_pid" >>"$OUT_DIR/$label.meta"
      sample_process_once "$app_pid" "$sample_file"
    fi

    if ! kill -0 "$runner_pid" >/dev/null 2>&1; then
      set +e
      wait "$runner_pid"
      local runner_exit=$?
      set -e
      echo "runner_exit=$runner_exit" >>"$OUT_DIR/$label.meta"
      return 0
    fi
    sleep 0.1
  done

  echo "runner_timeout_after_seconds=20" >>"$OUT_DIR/$label.meta"
  terminate_app_processes
  wait "$runner_pid" >/dev/null 2>&1 || true
}

run_launchservices_probe() {
  local label="$1"
  local extra_env_name="${2:-}"
  local extra_env_value="${3:-}"
  local stderr_file="$OUT_DIR/$label.stderr.log"
  local stdout_file="$OUT_DIR/$label.stdout.log"
  local bootstrap_file="$OUT_DIR/$label.bootstrap.log"
  local stream_file="$OUT_DIR/$label.system-stream.log"
  local stream_pid

  diag_log "running LaunchServices probe: $label"
  stream_pid="$(start_log_stream "$stream_file")"
  {
    echo "label=$label"
    echo "started_utc=$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    echo "bootstrap_file=$bootstrap_file"
    [[ -n "$extra_env_name" ]] && echo "$extra_env_name=$extra_env_value"
  } >"$OUT_DIR/$label.meta"

  if [[ -n "$extra_env_name" ]]; then
    open -n -W \
      --stdout "$stdout_file" \
      --stderr "$stderr_file" \
      --env ELECTRON_ENABLE_LOGGING=1 \
      --env ORCA_STARTUP_DIAGNOSTICS=trace \
      --env ORCA_STARTUP_DIAGNOSTICS_TRACE_LIMIT=30000 \
      --env ORCA_STARTUP_DIAGNOSTICS_FILE="$bootstrap_file" \
      --env "$extra_env_name=$extra_env_value" \
      "$APP_DIR" &
  else
    open -n -W \
      --stdout "$stdout_file" \
      --stderr "$stderr_file" \
      --env ELECTRON_ENABLE_LOGGING=1 \
      --env ORCA_STARTUP_DIAGNOSTICS=trace \
      --env ORCA_STARTUP_DIAGNOSTICS_TRACE_LIMIT=30000 \
      --env ORCA_STARTUP_DIAGNOSTICS_FILE="$bootstrap_file" \
      "$APP_DIR" &
  fi
  local runner_pid="$!"
  wait_for_probe "$runner_pid" "$label"
  echo "ended_utc=$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >>"$OUT_DIR/$label.meta"
  stop_log_stream "$stream_pid"
}

run_direct_exec_probe() {
  local label="direct-exec"
  local stderr_file="$OUT_DIR/$label.stderr.log"
  local stdout_file="$OUT_DIR/$label.stdout.log"
  local bootstrap_file="$OUT_DIR/$label.bootstrap.log"
  local stream_file="$OUT_DIR/$label.system-stream.log"
  local stream_pid

  diag_log "running direct exec probe"
  stream_pid="$(start_log_stream "$stream_file")"
  {
    echo "label=$label"
    echo "started_utc=$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    echo "bootstrap_file=$bootstrap_file"
  } >"$OUT_DIR/$label.meta"

  ELECTRON_ENABLE_LOGGING=1 \
    ORCA_STARTUP_DIAGNOSTICS=trace \
    ORCA_STARTUP_DIAGNOSTICS_TRACE_LIMIT=30000 \
    ORCA_STARTUP_DIAGNOSTICS_FILE="$bootstrap_file" \
    "$APP_DIR/Contents/MacOS/Orca" >"$stdout_file" 2>"$stderr_file" &
  local runner_pid="$!"
  wait_for_probe "$runner_pid" "$label"
  echo "ended_utc=$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >>"$OUT_DIR/$label.meta"
  stop_log_stream "$stream_pid"
}

write_system_log_snapshot() {
  local predicate='process == "Orca" OR eventMessage CONTAINS[c] "Orca" OR eventMessage CONTAINS[c] "com.stablyai.orca"'
  if command -v log >/dev/null 2>&1; then
    diag_log "capturing recent unified log snapshot"
    command log show --style syslog --last 10m --predicate "$predicate" >"$OUT_DIR/system-log-last-10m.log" 2>&1 || true
  fi
}

package_results() {
  {
    echo "Diagnostics completed."
    echo "Tag: $TAG"
    echo "Output zip: $ZIP_PATH"
    echo
    echo "Please attach this zip to the GitHub issue:"
    echo "  $ZIP_PATH"
  } >"$OUT_DIR/README.txt"

  diag_log "creating zip"
  (cd "$OUT_DIR" && zip -qry "$ZIP_PATH" .)
  diag_log "wrote $ZIP_PATH"
}

write_environment_report
ensure_no_existing_orca
download_and_copy_app
write_app_report
run_launchservices_probe "launchservices-trace"
run_launchservices_probe "launchservices-bypass-lock" "ORCA_BYPASS_SINGLE_INSTANCE_LOCK" "1"
run_direct_exec_probe
write_system_log_snapshot
package_results
