#!/usr/bin/env bash
# Gate for merging into cloud/integration (no CI on nwparker/orca-private). Run from your branch, before merging:
#   config/scripts/cloud-integration/premerge-check.sh
# Merges the current private/cloud/integration into a throwaway worktree with your branch, then requires
#   pnpm typecheck, the full pnpm lint suite (pre-commit hooks only lint staged files), and vitest for the tests your
#   branch touched: changed *.test.ts(x), every test in the folder of each changed source, every test that imports a
#   changed module, every test Vitest's module graph relates to the change (vitest --changed), and each touched cloud/apps/* package's own suite, plus the own `pnpm typecheck` of each touched cloud/ package listed
#   in premerge-typecheck-packages.txt. PREMERGE_FULL=1 runs the whole vitest suite.
#   E2E-style and runner-specific suites (tests/e2e/, *.e2e/integration/electron/chromium/live-shell/wsl/windows/win32
#   .test.*) are skipped in targeted runs; PREMERGE_E2E=1 includes them.
# The merged copy of this script is what runs, so the gate is always integration's current one.
# Prints "premerge OK" only when everything passes. Nothing here reads /tmp state. On macOS (no flock) wrap heavy runs
# as /tmp/vdrv/heavy.sh 'config/scripts/cloud-integration/premerge-check.sh'.
set -euo pipefail
# macOS: /tmp and /var are symlinks into /private. Tests that build expected paths from os.tmpdir() then compare them with a
# realpath'd value (packaged-cli-assets' macOS launcher argv, #574) fail only because of that. Resolve TMPDIR once so the gate's
# environment matches what child processes see.
TMPDIR=$(cd "${TMPDIR:-/tmp}" && pwd -P); export TMPDIR
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
  changed_src=$(git diff --name-only --diff-filter=AMR "$base"...HEAD -- 'src/*')
  n_changed=$(printf "%s\n" "$changed_src" | grep -c . || true)
  # A wide change (an upstream sync touches thousands of files) selects nearly everything anyway, and the per-file
  # selection below costs O(changed x tests). Over the threshold, run every src test instead.
  if ((n_changed > ${PREMERGE_SELECT_ALL_OVER:-300})); then
    # The E2E/runner-specific skip below applies here too.
    while IFS= read -r t; do
      if [[ -n "$t" && -f "$t" ]]; then tests+=("$t"); fi
    done <<<"$all_tests"
    echo "premerge: $n_changed changed src files (over ${PREMERGE_SELECT_ALL_OVER:-300}); selecting every src test file"
  elif ((n_changed > 0)); then
    folders=()
    modules=()
    while IFS= read -r file; do
      case "$file" in
        *.test.ts | *.test.tsx) if [[ -f "$file" ]]; then tests+=("$file"); fi ;;
        *.ts | *.tsx)
          folders+=("$(dirname "$file")")
          module=$(basename "${file%.*}")
          if [[ "$module" == index ]]; then module=$(basename "$(dirname "$file")"); fi
          modules+=("$module")
          ;;
      esac
    done <<<"$changed_src"
    if ((${#folders[@]})); then
      # (a) every test in a changed source's folder: one pass over the test list.
      while IFS= read -r t; do
        if [[ -n "$t" ]]; then tests+=("$t"); fi
      done < <(printf "%s\n" "$all_tests" |
        awk 'NR == FNR { want[$0] = 1; next } { d = $0; sub(/\/[^\/]*$/, "", d); if (d in want) print }' \
          <(printf "%s\n" "${folders[@]}" | sort -u) -)
      # (b) every test that imports a changed module by name: one grep over all tests for all names.
      names=$(printf "%s\n" "${modules[@]}" | sort -u | sed 's/[][\.*^$+?(){}|/]/\\&/g' | paste -sd '|' -)
      while IFS= read -r t; do
        if [[ -n "$t" ]]; then tests+=("$t"); fi
      done < <(printf "%s\n" "$all_tests" | xargs grep -lE "['\"][^'\"]*/(${names})(\\.tsx?)?['\"]" 2>/dev/null || true)
    fi
    # (c) Vitest's own module graph: every test that transitively imports a changed file (`vitest list --changed`).
    # Name matching alone misses cases like the multiplex tests: they import an aggregator (methods/terminal/terminal) that
    # imports the changed modules, one folder up.
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
  # Always-run tests: source-scanning lints (they glob/read src rather than import it, so neither name matching nor the
  # module graph selects them; #610 broke cloud-glossary-lint unnoticed). One repo path per line, # comments allowed.
  always=config/scripts/cloud-integration/premerge-always-tests.txt
  if [[ -f "$always" ]]; then
    while IFS= read -r t; do
      t=${t%%#*}; t=${t//[[:space:]]/}
      if [[ -n "$t" && -f "$t" ]]; then tests+=("$t"); fi
    done <"$always"
  fi
  if ((${#tests[@]} > 0)); then
    # Skip files on the full-suite base list: they fail on upstream too (this Mac's environment), so they would only
    # block. Exact whole-line matches only (filter-base-list-tests.sh, unit-tested); repo paths have no spaces.
    tests=($(printf "%s\n" "${tests[@]}" | sort -u |
      bash config/scripts/cloud-integration/filter-base-list-tests.sh config/scripts/cloud-integration/full-suite-base-list.txt))
    # E2E-style, integration and runner-specific suites (Electron, Chromium, a login zsh, WSL, Windows) are slow or need
    # hosts the offload lanes don't have, so they mostly ate gate time. Skipped by default in every targeted mode;
    # PREMERGE_E2E=1 brings them back. The per-cut full suite still runs them. Only the count is printed: lane
    # watchdogs look for those file names in the output.
    if [[ "${PREMERGE_E2E:-}" != 1 ]]; then
      skip_re=${PREMERGE_SKIP_TESTS_RE:-${PREMERGE_SELECT_ALL_EXCLUDE:-'(^|/)tests/e2e/|\.(e2e|integration|electron|chromium|live-shell|wsl|windows|win32)\.test\.[cm]?[jt]sx?$'}}
      kept=()
      n_skipped=0
      for t in "${tests[@]}"; do
        if [[ "$t" =~ $skip_re ]]; then n_skipped=$((n_skipped + 1)); else kept+=("$t"); fi
      done
      tests=(${kept[@]+"${kept[@]}"})
      echo "premerge: skipped $n_skipped E2E/runner-specific test file(s) matching $skip_re (PREMERGE_E2E=1 runs them)"
    fi
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
# cloud/ is its own pnpm workspace (own lockfile). Its apps import the built workspace packages (@orca-cloud/*) and
# their own dependencies (pg, ...), so install it and build its packages before running any cloud app suite.
cloud_apps=$(git diff --name-only "$base"...HEAD -- cloud/apps | cut -d/ -f1-3 | sort -u)
cloud_pkgs=$(git diff --name-only "$base"...HEAD -- cloud/apps cloud/packages | cut -d/ -f1-3 | sort -u)
# Cloud apps import desktop modules from src/shared/ by relative path, which neither the root typecheck nor the src test
# selection covers: #847 removed src/shared/cloud-workspaces exports sandbox-control used and passed premerge. Any
# src/shared change also runs the suite and typecheck of every cloud app that imports from src/shared.
if [[ -n "$(git diff --name-only "$base"...HEAD -- src/shared)" ]]; then
  shared_apps=$(git grep -lE "(\.\./)+src/shared/" -- 'cloud/apps/*' | cut -d/ -f1-3 | sort -u)
  if [[ -n "$shared_apps" ]]; then
    echo "premerge: src/shared changed; adding the cloud apps that import it:" $shared_apps
    cloud_apps=$(printf "%s\n" $cloud_apps $shared_apps | sort -u)
    cloud_pkgs=$(printf "%s\n" $cloud_pkgs $shared_apps | sort -u)
  fi
fi
if [[ -n "$cloud_pkgs" ]]; then
  (cd cloud && pnpm install --frozen-lockfile >/dev/null && pnpm -r --filter "./packages/**" build >/dev/null)
fi
for app in $cloud_apps; do
  if [[ -d "$app" ]]; then (cd "$app" && npx vitest run); fi
done
# The root `pnpm typecheck` above covers no cloud/ package, and vitest strips types, so cloud packages' own type errors
# went unseen (261 in sandbox-control by 2026-11-13). Typecheck each touched cloud package that is listed as clean.
# The cloud workspace was installed and built above.
tc_list=config/scripts/cloud-integration/premerge-typecheck-packages.txt
tc_pkgs=()
for pkg in $cloud_pkgs; do
  if [[ -d "$pkg" ]] && grep -qx "$pkg" "$tc_list" 2>/dev/null; then tc_pkgs+=("$pkg"); fi
done
if ((${#tc_pkgs[@]})); then
  for pkg in "${tc_pkgs[@]}"; do
    echo "premerge: typecheck $pkg"
    (cd "$pkg" && pnpm typecheck)
  done
fi
# Image or VM-script changes: boot the image twice (Docker); the second boot must be clean. Fails open without Docker.
if [[ -n "$(git diff --name-only "$base"...HEAD -- cloud/apps/sandbox-control/image)" ]]; then
  bash config/scripts/cloud-integration/boot-twice-check.sh
fi
if [[ "${PREMERGE_FULL:-}" == 1 ]]; then scope="the full vitest suite"; else scope="${#tests[@]} targeted test file(s)"; fi
echo "premerge OK: $branch merges cleanly into cloud/integration with typecheck, lint and $scope green."
