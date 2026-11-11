#!/usr/bin/env bash
# usage: filter-base-list-tests.sh <base-list-file> < test-paths
# Prints each test path from stdin that is NOT an exact line of the base list (stdout), and logs every path it drops
# as "premerge: skipping base-list test <path>" (stderr). Matching is whole-line and literal, so a path that merely
# shares a prefix, a directory or a suffix with a base-list entry is kept. A missing base list drops nothing.
set -euo pipefail
base_list=${1:?usage: filter-base-list-tests.sh <base-list-file> < test-paths}
while IFS= read -r t; do
  if [[ -z "$t" ]]; then continue; fi
  if [[ -f "$base_list" ]] && grep -qxF -- "$t" "$base_list"; then
    echo "premerge: skipping base-list test $t" >&2
  else
    printf '%s\n' "$t"
  fi
done
