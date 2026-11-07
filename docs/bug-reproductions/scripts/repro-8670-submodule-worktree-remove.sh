#!/usr/bin/env bash
# Issue #8670 — clean linked worktree with initialised submodule cannot be removed
# without git worktree remove --force.
#
# Re-run:
#   bash docs/bug-reproductions/scripts/repro-8670-submodule-worktree-remove.sh
#
# Writes evidence to docs/bug-reproductions/evidence/8670-git-submodule-remove.txt

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EVIDENCE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/evidence"
mkdir -p "$EVIDENCE_DIR"
OUT="$EVIDENCE_DIR/8670-git-submodule-remove.txt"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/orca-repro-8670.XXXXXX")"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

git version | tee "$OUT"
echo "fixture: $TMP" | tee -a "$OUT"

git -C "$TMP" init -q submodule-src
git -C "$TMP/submodule-src" config user.email repro@example.com
git -C "$TMP/submodule-src" config user.name repro
echo sub >"$TMP/submodule-src/file.txt"
git -C "$TMP/submodule-src" add file.txt
git -C "$TMP/submodule-src" commit -q -m init

git -C "$TMP" init -q main
git -C "$TMP/main" config user.email repro@example.com
git -C "$TMP/main" config user.name repro
echo root >"$TMP/main/README.md"
git -C "$TMP/main" add README.md
git -C "$TMP/main" commit -q -m init
# Why: Git ≥2.38 blocks file:// submodule clones unless protocol.file.allow=always.
git -C "$TMP/main" -c protocol.file.allow=always submodule add "$TMP/submodule-src" vendor/sub
git -C "$TMP/main" commit -q -m 'add submodule'

git -C "$TMP/main" worktree add -q -b feature "$TMP/wt-feature"
git -C "$TMP/wt-feature" -c protocol.file.allow=always submodule update --init

{
  echo "parent status:"; git -C "$TMP/wt-feature" status --short --untracked-files=all || true
  echo "submodule status:"; git -C "$TMP/wt-feature/vendor/sub" status --short --untracked-files=all || true
} | tee -a "$OUT"

set +e
git -C "$TMP/main" worktree remove "$TMP/wt-feature" 2>"$TMP/err-noforce.txt"
noforce=$?
set -e
{
  echo "--- without --force (exit $noforce) ---"
  cat "$TMP/err-noforce.txt"
} | tee -a "$OUT"

set +e
git -C "$TMP/main" worktree remove --force "$TMP/wt-feature" 2>"$TMP/err-force.txt"
force=$?
set -e
{
  echo "--- with --force (exit $force) ---"
  cat "$TMP/err-force.txt"
  if [[ ! -d "$TMP/wt-feature" ]]; then
    echo "worktree path removed: yes"
  else
    echo "worktree path removed: no"
  fi
} | tee -a "$OUT"

if [[ "$noforce" -ne 0 ]] && grep -q 'working trees containing submodules cannot be moved or removed' "$TMP/err-noforce.txt" && [[ "$force" -eq 0 ]]; then
  echo "RESULT: REPRODUCED (clean submodule worktree requires --force)" | tee -a "$OUT"
  exit 0
fi
echo "RESULT: NOT REPRODUCED" | tee -a "$OUT"
exit 1
