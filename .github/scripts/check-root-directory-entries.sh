#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <base-sha> <head-sha>" >&2
  exit 2
fi

base_sha=$1
head_sha=$2
git rev-parse --verify "${base_sha}^{tree}" >/dev/null
git rev-parse --verify "${head_sha}^{tree}" >/dev/null

declare -A base_entries=()
while IFS= read -r -d '' entry; do
  base_entries["$entry"]=1
done < <(git ls-tree -z --name-only "$base_sha")

blocked_entries=()
while IFS= read -r -d '' entry; do
  if [[ -z "${base_entries[$entry]+present}" ]]; then
    blocked_entries+=("$entry")
  fi
done < <(git ls-tree -z --name-only "$head_sha")

if (( ${#blocked_entries[@]} == 0 )); then
  echo "Root directory guard passed: no new root-level files or folders."
  exit 0
fi

echo "::error title=Root-level additions blocked::New root-level files or folders bloat the GitHub landing page."
echo "Root directory guard failed."
echo "New root-level files or folders are not allowed because they bloat the GitHub landing page."
echo "Move each new entry under an existing top-level directory."
printf 'Blocked entries:\n'
printf '  %s\n' "${blocked_entries[@]}"
exit 1
