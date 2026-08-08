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

# Why plain array + linear scan: stock macOS ships bash 3.2 without associative
# arrays (`declare -A`), and `pnpm test` invokes this script via PATH `bash`
# (#12878). Root-level entries stay tiny, so O(n^2) membership is fine.
base_entries=()
while IFS= read -r -d '' entry; do
  base_entries+=("$entry")
done < <(git ls-tree -z --name-only "$base_sha")

base_has_entry() {
  local candidate=$1
  local existing
  # Why + expansion: bash 3.2 with set -u rejects empty "${arr[@]}" expansion.
  for existing in ${base_entries[@]+"${base_entries[@]}"}; do
    if [[ "$existing" == "$candidate" ]]; then
      return 0
    fi
  done
  return 1
}

blocked_entries=()
while IFS= read -r -d '' entry; do
  if ! base_has_entry "$entry"; then
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
