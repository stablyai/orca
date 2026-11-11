#!/usr/bin/env bash
# Gate for merging into cloud/integration (no CI on nwparker/orca-private). Run from your branch, before merging:
#   config/scripts/cloud-integration/premerge-check.sh
# Merges the current private/cloud/integration into a throwaway worktree with your branch, then requires
#   pnpm typecheck, the full pnpm lint suite (pre-commit hooks only lint staged files), and vitest for the tests your
#   branch touched: changed *.test.ts(x), every test in the folder of each changed source, every test that imports a
#   changed module, and each touched cloud/apps/* package's own suite. PREMERGE_FULL=1 runs the whole vitest suite.
# The merged copy of this script is what runs, so the gate is always integration's current one.
# Prints "premerge OK" only when everything passes. Nothing here reads /tmp state. On macOS (no flock) wrap heavy runs
# as /tmp/vdrv/heavy.sh 'config/scripts/cloud-integration/premerge-check.sh'.
set -euo pipefail
base=private/cloud/integration
if [[ -z "${PREMERGE_IN_WORKTREE:-}" ]]; then
  branch=$(git rev-parse --abbrev-ref HEAD)
  git fetch -q private +cloud/integration:refs/remotes/private/cloud/integration
  dir=$(mktemp -d "${TMPDIR:-/tmp}/cloud-premerge-XXXX")
  git worktree add -q --detach "$dir" HEAD
  if ! (cd "$dir" && git merge -q --no-edit "$base"); then
    git worktree remove --force "$dir" >/dev/null 2>&1 || true
    exit 1
  fi
  # Re-run the MERGED copy of this script, so a branch cut before a gate change still gets the current gate.
  exec env PREMERGE_IN_WORKTREE="$dir" PREMERGE_BRANCH="$branch" bash "$dir/config/scripts/cloud-integration/premerge-check.sh"
fi
dir=$PREMERGE_IN_WORKTREE
branch=${PREMERGE_BRANCH:-unknown}
# At most PREMERGE_MAX_CONCURRENT (default 2) premerges run their heavy part (install, typecheck, lint, tests) at once
# on this machine; the rest queue here and log while they wait (one shared Mac, load 60 starved the e2e harness).
# Slots are flock'd files under PREMERGE_LOCK_DIR (default /tmp/vdrv, else $TMPDIR), held by a python parent until the
# run ends, so a killed run frees its slot. This sits after the merge and before anything heavy, in the merged copy
# every branch re-runs (#447), so all branches pick it up. Set PREMERGE_SLOT=none to bypass (for tests only).
if [[ -z "${PREMERGE_SLOT:-}" ]]; then
  lock_dir=${PREMERGE_LOCK_DIR:-$([[ -d /tmp/vdrv ]] && echo /tmp/vdrv || echo "${TMPDIR:-/tmp}")}
  exec /usr/bin/python3 -I -c '
import fcntl, os, subprocess, sys, time
lock_dir, slots, script, branch = sys.argv[1], max(1, int(sys.argv[2])), sys.argv[3], sys.argv[4]
start, last, held = time.time(), -1.0, None
while held is None:
    for i in range(1, slots + 1):
        f = open(os.path.join(lock_dir, f"premerge-slot-{i}.lock"), "a")
        try:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
            held = (i, f)
            break
        except BlockingIOError:
            f.close()
    if held is None:
        waited = time.time() - start
        if last < 0 or waited - last >= 30:
            print(f"premerge: queued for one of {slots} slots ({branch}), waited {int(waited)}s", flush=True)
            last = waited
        time.sleep(5)
waited = int(time.time() - start)
print(f"premerge: got slot {held[0]}/{slots} after {waited}s", flush=True)
env = dict(os.environ, PREMERGE_SLOT=str(held[0]))
sys.exit(subprocess.call(["bash", script], env=env))
' "$lock_dir" "${PREMERGE_MAX_CONCURRENT:-2}" "$dir/config/scripts/cloud-integration/premerge-check.sh" "$branch"
fi
trap 'git -C "$dir" worktree remove --force "$dir" >/dev/null 2>&1 || true' EXIT
cd "$dir"
pnpm install --frozen-lockfile >/dev/null
pnpm typecheck
pnpm lint

tests=()
if [[ "${PREMERGE_FULL:-}" == 1 ]]; then
  # Full suite via the repo's own runner (what every build cut runs before its smoke). Slow; use for wide changes.
  pnpm test
else
  # Targeted tests. Sibling filenames alone missed real regressions (#347 broke a *-race.test.ts in the same folder),
  # so for each changed source this also runs (a) every test in its folder and (b) every test under src/ that
  # imports it by module name (relative path, '@/' alias, vi.mock or dynamic import). Over-selection is fine.
  all_tests=$(git ls-files 'src/*.test.ts' 'src/*.test.tsx')
  while IFS= read -r file; do
    case "$file" in
      *.test.ts | *.test.tsx) if [[ -f "$file" ]]; then tests+=("$file"); fi ;;
      *.ts | *.tsx)
        folder=$(dirname "$file")
        while IFS= read -r t; do
          if [[ -n "$t" && "$(dirname "$t")" == "$folder" ]]; then tests+=("$t"); fi
        done <<<"$all_tests"
        module=$(basename "${file%.*}")
        if [[ "$module" == index ]]; then module=$(basename "$folder"); fi
        while IFS= read -r t; do
          if [[ -n "$t" ]]; then tests+=("$t"); fi
        done < <(printf "%s\n" "$all_tests" | xargs grep -lE "['\"][^'\"]*/${module}(\\.tsx?)?['\"]" 2>/dev/null || true)
        ;;
    esac
  done < <(git diff --name-only --diff-filter=AMR "$base"...HEAD -- 'src/*')
  if ((${#tests[@]} > 0)); then
    # Skip files on the full-suite base list: they fail on upstream too (this Mac's environment), so they would only
    # block. Exact whole-line matches only (filter-base-list-tests.sh, unit-tested); repo paths have no spaces.
    tests=($(printf "%s\n" "${tests[@]}" | sort -u |
      bash config/scripts/cloud-integration/filter-base-list-tests.sh config/scripts/cloud-integration/full-suite-base-list.txt))
    echo "premerge: ${#tests[@]} targeted test file(s):"
  fi
  if ((${#tests[@]} > 0)); then
    printf "  %s\n" "${tests[@]}"
    node config/scripts/workspace-package-build/build-workspace-packages.mjs >/dev/null
    node config/scripts/native-build/node-addons/ensure-native-runtime.mjs --runtime=node >/dev/null
    # run-vitest.mjs applies the repo's test env policy (e.g. ORCA_BACKGROUND_LAUNCH=1); bare vitest gives false failures.
    node config/scripts/test-runtime/execution-policy/run-vitest.mjs run --config config/vitest.config.ts "${tests[@]}"
  fi
fi
for app in $(git diff --name-only "$base"...HEAD -- cloud/apps | cut -d/ -f1-3 | sort -u); do
  if [[ -d "$app" ]]; then (cd "$app" && npx vitest run); fi
done
if [[ "${PREMERGE_FULL:-}" == 1 ]]; then scope="the full vitest suite"; else scope="${#tests[@]} targeted test file(s)"; fi
echo "premerge OK: $branch merges cleanly into cloud/integration with typecheck, lint and $scope green."
