#!/usr/bin/env bash
# Gate for merging into cloud/integration (no CI on nwparker/orca-private). Run from your branch, before merging:
#   config/scripts/cloud-integration/premerge-check.sh
# Merges the current private/cloud/integration into a throwaway worktree with your branch, then requires
#   pnpm typecheck, the full pnpm lint suite (pre-commit hooks only lint staged files), and vitest for the tests your
#   branch touched: changed *.test.ts(x), every test in the folder of each changed source, every test that imports a
#   changed module, every test Vitest's module graph relates to the change (vitest --changed), and each touched cloud/apps/* package's own suite. PREMERGE_FULL=1 runs the whole vitest suite.
# The merged copy of this script is what runs, so the gate is always integration's current one.
# Prints "premerge OK" only when everything passes. Nothing here reads /tmp state. On macOS (no flock) wrap heavy runs
# as /tmp/vdrv/heavy.sh 'config/scripts/cloud-integration/premerge-check.sh'.
set -euo pipefail
base=private/cloud/integration
if [[ -z "${PREMERGE_IN_WORKTREE:-}" ]]; then
  branch=$(git rev-parse --abbrev-ref HEAD)
  git fetch -q private +cloud/integration:refs/remotes/private/cloud/integration
  dir=$(mktemp -d "${TMPDIR:-/tmp}/cloud-premerge-XXXX")
  # Until the exec below hands over, a kill or failure here removes the temp worktree (exec doesn't fire this trap).
  trap 'git worktree remove --force "$dir" >/dev/null 2>&1 || true; rm -rf "$dir"; git worktree prune >/dev/null 2>&1 || true' EXIT
  trap 'exit 130' INT TERM
  git worktree add -q --detach "$dir" HEAD
  if ! (cd "$dir" && git merge -q --no-edit "$base"); then
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
import fcntl, os, shutil, signal, subprocess, sys, time
lock_dir, slots, wt, branch = sys.argv[1], max(1, int(sys.argv[2])), sys.argv[3], sys.argv[4]
script = os.path.join(wt, "config/scripts/cloud-integration/premerge-check.sh")
child = None
def cleanup():
    # Whatever happens (killed while queued or while running, or finished), the temp merge worktree goes away.
    common = subprocess.run(["git", "-C", wt, "rev-parse", "--path-format=absolute", "--git-common-dir"],
                            capture_output=True, text=True).stdout.strip()
    subprocess.run(["git", "-C", wt, "worktree", "remove", "--force", wt], capture_output=True)
    shutil.rmtree(wt, ignore_errors=True)
    if common:
        subprocess.run(["git", "--git-dir", common, "worktree", "prune"], capture_output=True)
def on_signal(sig, _frame):
    if child is not None and child.poll() is None:
        child.send_signal(sig)
        try:
            child.wait(timeout=20)
        except subprocess.TimeoutExpired:
            child.kill()
    print(f"premerge: stopped by signal {sig}; removed {wt}", flush=True)
    sys.exit(128 + sig)
signal.signal(signal.SIGINT, on_signal)
signal.signal(signal.SIGTERM, on_signal)
try:
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
    print(f"premerge: got slot {held[0]}/{slots} after {int(time.time() - start)}s", flush=True)
    child = subprocess.Popen(["bash", script], env=dict(os.environ, PREMERGE_SLOT=str(held[0])))
    rc = child.wait()
finally:
    cleanup()
sys.exit(rc)
' "$lock_dir" "${PREMERGE_MAX_CONCURRENT:-2}" "$dir" "$branch"
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
  # (c) Vitest's own module graph: every test that transitively imports a changed file (`vitest list --changed`).
  # Name matching alone missed #462's REG-5: the multiplex tests import an aggregator (methods/terminal/terminal) that
  # imports the changed modules, one folder up.
  if [[ -n "$(git diff --name-only "$base"...HEAD -- 'src/*')" ]]; then
    node config/scripts/workspace-package-build/build-workspace-packages.mjs >/dev/null
    node config/scripts/native-build/node-addons/ensure-native-runtime.mjs --runtime=node >/dev/null
    graph=$(node config/scripts/test-runtime/execution-policy/run-vitest.mjs list --config config/vitest.config.ts \
      --changed="$base" --filesOnly 2>/dev/null | sed -E 's/^\[[^]]*\] //' | grep -E '\.test\.(ts|tsx|mts|mjs|js)$' | sort -u || true)
    n_graph=0
    while IFS= read -r t; do
      if [[ -n "$t" && -f "$t" ]]; then tests+=("$t"); n_graph=$((n_graph + 1)); fi
    done <<<"$graph"
    echo "premerge: module graph (vitest --changed=$base) adds $n_graph related test file(s)"
  fi
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
    # Batches of PREMERGE_TEST_BATCH (default 150) files: a PR touching widely imported modules (#574) selected so many
    # tests that spawning vitest failed with E2BIG. Every batch must pass (set -e); same files, same gate.
    batch=${PREMERGE_TEST_BATCH:-150}
    for ((i = 0; i < ${#tests[@]}; i += batch)); do
      chunk=("${tests[@]:i:batch}")
      echo "premerge: vitest batch $((i / batch + 1)) of $(((${#tests[@]} + batch - 1) / batch)) (${#chunk[@]} file(s))"
      # A batch that fails in parallel is re-run ONCE with a single worker (#574: Electron extension-worker tests failed
      # only under 150-file parallel load and pass alone). It passes only if the serial run is fully clean; a second
      # failure fails the gate as before. Logged, so the record shows the retry.
      if ! node config/scripts/test-runtime/execution-policy/run-vitest.mjs run --config config/vitest.config.ts "${chunk[@]}"; then
        echo "premerge: batch $((i / batch + 1)) failed in parallel; re-running it once with --maxWorkers=1"
        node config/scripts/test-runtime/execution-policy/run-vitest.mjs run --config config/vitest.config.ts --maxWorkers=1 "${chunk[@]}"
        echo "premerge: batch $((i / batch + 1)) failed in parallel, passed serially"
      fi
    done
  fi
fi
for app in $(git diff --name-only "$base"...HEAD -- cloud/apps | cut -d/ -f1-3 | sort -u); do
  if [[ -d "$app" ]]; then (cd "$app" && npx vitest run); fi
done
if [[ "${PREMERGE_FULL:-}" == 1 ]]; then scope="the full vitest suite"; else scope="${#tests[@]} targeted test file(s)"; fi
echo "premerge OK: $branch merges cleanly into cloud/integration with typecheck, lint and $scope green."
