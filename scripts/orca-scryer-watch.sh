#!/usr/bin/env bash
set -euo pipefail

repo_dir="${ORCA_SCRYER_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
upstream_remote="${ORCA_SCRYER_UPSTREAM_REMOTE:-origin}"
main_branch="${ORCA_SCRYER_MAIN_BRANCH:-main}"
state_dir="${ORCA_SCRYER_STATE_DIR:-$repo_dir/.git/orca-scryer-sync}"
log_dir="${ORCA_SCRYER_LOG_DIR:-$state_dir/logs}"
sync_command="${ORCA_SCRYER_SYNC_COMMAND:-$repo_dir/scripts/orca-scryer-sync.sh}"
state_file="$state_dir/origin-main.sha"

mkdir -p "$state_dir" "$log_dir"

lock_file="$state_dir/watch.lock"
exec 9>"$lock_file"
if ! flock -n 9; then
  echo "Another orca-scryer watch run is already active."
  exit 0
fi

remote_line="$(git -C "$repo_dir" ls-remote "$upstream_remote" "refs/heads/$main_branch")"
remote_sha="$(awk '{print $1}' <<<"$remote_line")"
if [[ -z "$remote_sha" ]]; then
  echo "Could not read $upstream_remote/$main_branch from $repo_dir." >&2
  exit 1
fi

last_sha=""
if [[ -f "$state_file" ]]; then
  last_sha="$(<"$state_file")"
fi

if [[ -z "$last_sha" ]]; then
  printf '%s\n' "$remote_sha" > "$state_file"
  echo "Initialized origin main state at $remote_sha. No sync run on first check."
  exit 0
fi

if [[ "$last_sha" == "$remote_sha" ]]; then
  echo "$upstream_remote/$main_branch unchanged at $remote_sha."
  exit 0
fi

timestamp="$(date +%Y%m%d-%H%M%S)"
log_file="$log_dir/sync-$timestamp.log"
echo "$upstream_remote/$main_branch changed: $last_sha -> $remote_sha"
echo "Running sync. Log: $log_file"

if ORCA_SCRYER_DETECTED_MAIN_SHA="$remote_sha" "$sync_command" >"$log_file" 2>&1; then
  printf '%s\n' "$remote_sha" > "$state_file"
  echo "Sync completed for $remote_sha."
else
  echo "Sync failed for $remote_sha. State was not advanced. See $log_file." >&2
  exit 1
fi
