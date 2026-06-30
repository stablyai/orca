#!/usr/bin/env bash
set -euo pipefail

repo_dir="${ORCA_SCRYER_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
watch_script="$repo_dir/scripts/orca-scryer-watch.sh"
state_dir="${ORCA_SCRYER_STATE_DIR:-$repo_dir/.git/orca-scryer-sync}"
log_dir="${ORCA_SCRYER_LOG_DIR:-$state_dir/logs}"
marker_start="# BEGIN orca-scryer-watch"
marker_end="# END orca-scryer-watch"

shell_quote() {
  printf '%q' "$1"
}

if ! command -v crontab >/dev/null 2>&1; then
  echo "crontab command not found. Install cron or add the schedule manually." >&2
  exit 1
fi

mkdir -p "$log_dir"

cron_env=("ORCA_SCRYER_REPO_DIR=$(shell_quote "$repo_dir")")
for name in \
  ORCA_SCRYER_AUTO_PACKAGE \
  ORCA_SCRYER_AUTO_INSTALL \
  ORCA_SCRYER_INSTALL_KIND \
  ORCA_SCRYER_APPIMAGE_INSTALL_PATH \
  ORCA_SCRYER_APPIMAGE_SYMLINK \
  ORCA_SCRYER_APPIMAGE_CLI_LAUNCHER \
  ORCA_SCRYER_PACKAGE_COMMAND \
  ORCA_SCRYER_ARTIFACT_DIR \
  ORCA_SCRYER_RELEASE_DIR; do
  if [[ -n "${!name:-}" ]]; then
    cron_env+=("$name=$(shell_quote "${!name}")")
  fi
done

cron_line="0 */12 * * * ${cron_env[*]} $(shell_quote "$watch_script") >> $(shell_quote "$log_dir/watch-cron.log") 2>&1"
current_cron="$(crontab -l 2>/dev/null || true)"
filtered_cron="$(awk -v start="$marker_start" -v end="$marker_end" '
  $0 == start { skipping = 1; next }
  $0 == end { skipping = 0; next }
  skipping != 1 { print }
' <<<"$current_cron")"

{
  printf '%s\n' "$filtered_cron"
  printf '%s\n' "$marker_start"
  printf '%s\n' "$cron_line"
  printf '%s\n' "$marker_end"
} | sed '/^$/N;/^\n$/D' | crontab -

echo "Installed orca-scryer watch cron:"
echo "$cron_line"
