#!/bin/sh
set -eu
if [ "$#" -eq 0 ]; then
  exit 0
fi

resolve_orca_cli_path() {
  if [ -n "${ORCA_FINDER_SERVICE_CLI_PATH:-}" ]; then
    printf '%s\n' "$ORCA_FINDER_SERVICE_CLI_PATH"
    return 0
  fi

  service_script_path=${ORCA_FINDER_SERVICE_SCRIPT_PATH:-$0}
  service_script_dir=$(CDPATH= cd -- "$(dirname -- "$service_script_path")" && pwd -P)
  resources_dir=$(CDPATH= cd -- "$service_script_dir/../../../.." && pwd -P)
  candidate="$resources_dir/bin/orca"
  if [ -x "$candidate" ]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  if command -v osascript >/dev/null 2>&1; then
    app_path=$(osascript -e 'POSIX path of (path to app id "com.stablyai.orca")' 2>/dev/null || true)
    if [ -n "$app_path" ]; then
      printf '%s\n' "$app_path/Contents/Resources/bin/orca"
      return 0
    fi
  fi
  printf '%s\n' 'Unable to resolve packaged Orca CLI path for Finder Service.' >&2
  return 1
}

orca_cli_path=$(resolve_orca_cli_path)
for selected_folder_path do
  "$orca_cli_path" finder terminal --path "$selected_folder_path"
done
