#!/usr/bin/env bash
set -euo pipefail

repo_dir="${ORCA_SCRYER_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
upstream_remote="${ORCA_SCRYER_UPSTREAM_REMOTE:-origin}"
fork_remote="${ORCA_SCRYER_FORK_REMOTE:-fork}"
main_branch="${ORCA_SCRYER_MAIN_BRANCH:-main}"
feature_branch="${ORCA_SCRYER_FEATURE_BRANCH:-orca-scryer}"
state_dir="${ORCA_SCRYER_STATE_DIR:-$repo_dir/.git/orca-scryer-sync}"
skip_tests="${ORCA_SCRYER_SKIP_TESTS:-0}"
skip_push="${ORCA_SCRYER_SKIP_PUSH:-0}"
auto_package="${ORCA_SCRYER_AUTO_PACKAGE:-0}"

mkdir -p "$state_dir"

lock_file="$state_dir/sync.lock"
exec 8>"$lock_file"
if ! flock -n 8; then
  echo "Another orca-scryer sync run is already active."
  exit 1
fi

run() {
  echo "+ $*"
  "$@"
}

run_feature_file_checks() {
  local file
  local feature_files=()
  local lint_files=()
  local format_files=()

  mapfile -t feature_files < <(
    git -C "$repo_dir" diff --name-only --diff-filter=ACMRT "$upstream_main"...HEAD
  )

  for file in "${feature_files[@]}"; do
    case "$file" in
      *.js | *.jsx | *.ts | *.tsx | *.mjs | *.cjs | *.mts | *.cts)
        lint_files+=("$file")
        format_files+=("$file")
        ;;
      *.json | *.jsonc | *.md | *.yml | *.yaml | *.html | *.css)
        format_files+=("$file")
        ;;
    esac
  done

  if [[ "${#lint_files[@]}" -gt 0 ]]; then
    run corepack pnpm exec oxlint "${lint_files[@]}"
  else
    echo "No feature files need oxlint."
  fi

  if [[ "${#format_files[@]}" -gt 0 ]]; then
    run corepack pnpm exec oxfmt --check "${format_files[@]}"
  else
    echo "No feature files need oxfmt."
  fi
}

ensure_remote() {
  local remote="$1"
  if ! git -C "$repo_dir" remote get-url "$remote" >/dev/null 2>&1; then
    echo "Missing git remote '$remote' in $repo_dir." >&2
    exit 1
  fi
}

is_dirty() {
  git -C "$repo_dir" update-index -q --refresh
  ! git -C "$repo_dir" diff --quiet ||
    ! git -C "$repo_dir" diff --cached --quiet ||
    [[ -n "$(git -C "$repo_dir" ls-files --others --exclude-standard)" ]]
}

stash_ref=""
restore_stash() {
  if [[ -z "$stash_ref" ]]; then
    return 0
  fi

  echo "Restoring stashed in-progress work: $stash_ref"
  if git -C "$repo_dir" stash apply --index "$stash_ref"; then
    git -C "$repo_dir" stash drop "$stash_ref" >/dev/null
    stash_ref=""
  else
    echo "Could not restore stashed work cleanly. The stash is still kept as $stash_ref." >&2
    exit 1
  fi
}

restore_stash_on_failure() {
  local status=$?
  if [[ "$status" -eq 0 || -z "$stash_ref" ]]; then
    exit "$status"
  fi

  local rebase_merge
  local rebase_apply
  rebase_merge="$(git -C "$repo_dir" rev-parse --git-path rebase-merge)"
  rebase_apply="$(git -C "$repo_dir" rev-parse --git-path rebase-apply)"
  if [[ -d "$rebase_merge" || -d "$rebase_apply" ]]; then
    echo "Sync failed during rebase. Stashed work is still kept as $stash_ref." >&2
    exit "$status"
  fi

  echo "Sync failed. Restoring stashed in-progress work before exiting."
  if git -C "$repo_dir" switch "$feature_branch" >/dev/null 2>&1 &&
    git -C "$repo_dir" stash apply --index "$stash_ref"; then
    git -C "$repo_dir" stash drop "$stash_ref" >/dev/null
    stash_ref=""
  else
    echo "Could not restore stashed work cleanly. The stash is still kept as $stash_ref." >&2
  fi
  exit "$status"
}

trap restore_stash_on_failure EXIT

ensure_remote "$upstream_remote"
ensure_remote "$fork_remote"

current_branch="$(git -C "$repo_dir" branch --show-current)"
if [[ -z "$current_branch" ]]; then
  echo "Repository is in detached HEAD state. Switch to $feature_branch before syncing." >&2
  exit 1
fi

if is_dirty; then
  if [[ "$current_branch" != "$feature_branch" ]]; then
    echo "Working tree is dirty on '$current_branch'. Switch to '$feature_branch' or commit/stash manually." >&2
    exit 1
  fi
  run git -C "$repo_dir" stash push -u -m "orca-scryer autosync $(date -Iseconds)"
  stash_ref="stash@{0}"
fi

run git -C "$repo_dir" fetch --prune "$upstream_remote" "$main_branch"
run git -C "$repo_dir" fetch --prune "$fork_remote" "$main_branch"
if git -C "$repo_dir" ls-remote --exit-code "$fork_remote" "refs/heads/$feature_branch" >/dev/null 2>&1; then
  run git -C "$repo_dir" fetch --prune "$fork_remote" "$feature_branch"
fi

upstream_main="$upstream_remote/$main_branch"
fork_main="$fork_remote/$main_branch"
fork_feature="$fork_remote/$feature_branch"

if ! git -C "$repo_dir" merge-base --is-ancestor "$fork_main" "$upstream_main"; then
  echo "$fork_main has commits that are not in $upstream_main. Refusing to overwrite fork main." >&2
  restore_stash
  exit 1
fi

run git -C "$repo_dir" push "$fork_remote" "refs/remotes/$upstream_main:refs/heads/$main_branch"

if ! git -C "$repo_dir" show-ref --verify --quiet "refs/heads/$feature_branch"; then
  if git -C "$repo_dir" show-ref --verify --quiet "refs/remotes/$fork_feature"; then
    run git -C "$repo_dir" switch -c "$feature_branch" --track "$fork_feature"
  else
    echo "Missing local and remote feature branch '$feature_branch'." >&2
    restore_stash
    exit 1
  fi
else
  run git -C "$repo_dir" switch "$feature_branch"
fi

run git -C "$repo_dir" branch -f "$main_branch" "$upstream_main"
run git -C "$repo_dir" branch --set-upstream-to="$upstream_main" "$main_branch"
run git -C "$repo_dir" rebase "$upstream_main"

if [[ "$skip_tests" != "1" ]]; then
  run corepack pnpm exec vitest run --config config/vitest.config.ts \
    src/main/ipc/architecture.test.ts \
    src/shared/scryer/parse-model.test.ts \
    src/shared/scryer/source-map-paths.test.ts \
    src/main/scryer/model-store.test.ts \
    src/main/scryer/drift.test.ts \
    src/main/scryer/sync.test.ts \
    src/main/scryer/mcp-tools.test.ts \
    src/renderer/src/components/tab-bar/group-tab-order.test.ts \
    src/renderer/src/components/terminal/tab-type-cycle.test.ts \
    src/renderer/src/lib/workspace-session.test.ts \
    src/renderer/src/store/slices/tabs.test.ts \
    src/renderer/src/lib/codex-account-failover.test.ts
  run corepack pnpm run tc:web
  run corepack pnpm run tc:node
  run_feature_file_checks
  run corepack pnpm exec playwright test --config tests/playwright.config.ts \
    tests/e2e/architecture-tab.spec.ts --project electron-headless
else
  echo "Skipping tests because ORCA_SCRYER_SKIP_TESTS=1."
fi

if [[ "$skip_push" != "1" ]]; then
  run git -C "$repo_dir" push --force-with-lease "$fork_remote" "$feature_branch"
else
  echo "Skipping push because ORCA_SCRYER_SKIP_PUSH=1."
fi

if [[ "$auto_package" == "1" ]]; then
  run "$repo_dir/scripts/orca-scryer-package-install.sh"
else
  echo "Skipping Ubuntu package/install because ORCA_SCRYER_AUTO_PACKAGE is not 1."
fi

run git -C "$repo_dir" fetch --prune "$fork_remote" "$main_branch" "$feature_branch"
run git -C "$repo_dir" branch -f "$main_branch" "$fork_main"
run git -C "$repo_dir" reset --hard "$fork_feature"

restore_stash

echo "orca-scryer sync completed."
