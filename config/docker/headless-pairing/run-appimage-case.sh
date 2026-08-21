#!/usr/bin/env bash
set -euo pipefail

case_name=${1:?launch case is required}
appimage=${MCODE_TEST_APPIMAGE:-/artifacts/squashfs-root/AppRun}
timeout_seconds=${MCODE_STARTUP_TIMEOUT_SECONDS:-12}
pairing_address=${MCODE_PAIRING_ADDRESS:-127.0.0.1}
port=${MCODE_SERVE_PORT:-0}
state_dir="/tmp/mcode-${case_name}"

if ((EUID == 0)); then
  mkdir -p "$state_dir/config" "$state_dir/cache"
  chown -R mcode:mcode "$state_dir"
  # Why: packaged serve should exercise the same unprivileged account required by production systemd guidance.
  exec runuser --user mcode --preserve-environment -- "$0" "$@"
fi

mkdir -p "$state_dir/config" "$state_dir/cache"

if [[ "$appimage" == *.AppImage ]]; then
  is_appimage=1
  launcher=("$appimage" --appimage-extract-and-run)
else
  is_appimage=0
  launcher=("$appimage")
fi

app_args=("${launcher[@]}")
if [[ ${MCODE_TEST_NO_SANDBOX:-1} == 1 ]]; then
  app_args+=(--no-sandbox)
fi
app_args+=(serve --port "$port" --pairing-address "$pairing_address")
if [[ ${MCODE_READY_JSON:-0} == 1 ]]; then
  app_args+=(--json)
fi
if [[ ${MCODE_NO_PAIRING:-0} == 1 ]]; then
  app_args+=(--no-pairing)
fi

case "$case_name" in
  direct)
    command=("${app_args[@]}")
    ;;
  xvfb)
    command=(xvfb-run -a "${app_args[@]}")
    ;;
  dbus-xvfb)
    command=(dbus-run-session -- xvfb-run -a "${app_args[@]}")
    ;;
  journal)
    command=(setsid --wait xvfb-run -a "${app_args[@]}")
    ;;
  *)
    echo "Unknown launch case: $case_name" >&2
    exit 64
    ;;
esac

export HOME="$state_dir"
export XDG_CONFIG_HOME="$state_dir/config"
export XDG_CACHE_HOME="$state_dir/cache"
if [[ $is_appimage == 0 ]]; then
  export APPDIR=${MCODE_TEST_APPDIR:-"$(dirname "$appimage")"}
fi

if [[ ${MCODE_KEEP_RUNNING:-0} == 1 ]]; then
  exec "${command[@]}"
fi

set +e
timeout --signal=TERM --kill-after=2s "${timeout_seconds}s" "${command[@]}"
status=$?
set -e

if ((status == 124)); then
  echo "STARTUP_TIMEOUT: no ready contract after ${timeout_seconds}s" >&2
fi
exit "$status"
