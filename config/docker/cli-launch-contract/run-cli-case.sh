#!/usr/bin/env bash
# Print a parseable verdict; the host script owns expected statuses.
set -uo pipefail

case_name=${1:?launch case is required}
extracted_root=${ORCA_TEST_EXTRACTED_ROOT:-/artifacts/squashfs-root}
launcher="$extracted_root/resources/bin/orca-ide"
command_timeout_seconds=${ORCA_TEST_COMMAND_TIMEOUT_SECONDS:-60}

if ((EUID == 0)); then
  # Reproduce extracted AppImage sandbox ownership as an unprivileged user.
  exec runuser --user orca --preserve-environment -- "$0" "$@"
fi

# Guard the restricted-userns precondition instead of accepting a false pass.
if [[ "$case_name" == *-userns-* ]]; then
  if unshare -Ur true 2>/dev/null; then
    echo "PRECONDITION_FAILED user namespaces are available; this case needs them restricted"
    exit 90
  fi
fi
if [[ "$case_name" == nofuse-* && -e /dev/fuse ]]; then
  echo "PRECONDITION_FAILED /dev/fuse is present; this case needs it absent"
  exit 90
fi

unset DISPLAY WAYLAND_DISPLAY XDG_RUNTIME_DIR
if [[ "$case_name" == stale-display-* ]]; then
  DISPLAY=:77
  export DISPLAY
fi

case "$case_name" in
  # The bundled launcher must stay in Electron's node mode.
  nofuse-userns-bundled-help) command=("$launcher" --help) ;;
  nofuse-userns-bundled-version) command=("$launcher" --version) ;;
  nofuse-userns-bundled-status) command=("$launcher" status) ;;
  nofuse-userns-bundled-skills) command=("$launcher" skills --help) ;;
  nofuse-userns-bundled-worktree) command=("$launcher" worktree list) ;;
  # Direct binaries must hand off before Ozone initializes.
  nofuse-nosandbox-direct-binary-skills)
    command=("$extracted_root/orca-ide" --no-sandbox skills --help)
    ;;
  nofuse-nosandbox-direct-binary-gui)
    command=("$extracted_root/orca-ide" --no-sandbox)
    ;;
  stale-display-nosandbox-direct-binary-gui)
    command=("$extracted_root/orca-ide" --no-sandbox)
    ;;
  *)
    echo "UNKNOWN_CASE $case_name"
    exit 91
    ;;
esac

output=$(timeout --foreground --signal=TERM --kill-after=5s "${command_timeout_seconds}s" "${command[@]}" 2>&1)
status=$?

if ((status == 124)); then
  echo "TIMED_OUT seconds=$command_timeout_seconds case=$case_name"
  printf '%s\n' "$output" | tail -30
  exit 94
fi

if [[ "$case_name" == nofuse-userns-bundled-version ]]; then
  version_file="$extracted_root/resources/app.asar.unpacked/out/package.json"
  expected_version=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$version_file")
  if [[ -z "$expected_version" || "$output" != "$expected_version" ]]; then
    output="VERSION_MISMATCH expected=${expected_version:-missing} got=$output"
    status=93
  fi
fi

# Shell signal exits are reported as 128 plus the signal number.
if ((status >= 128)); then
  echo "CRASHED status=$status case=$case_name"
  printf '%s\n' "$output" | tail -30
  exit 92
fi

echo "RESULT status=$status case=$case_name"
# Preserve the help header used by output assertions.
printf '%s\n' "$output" | head -200
exit 0
