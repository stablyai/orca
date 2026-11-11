#!/usr/bin/env bash
# Gate for merging into cloud/integration (no CI on nwparker/orca-private). Run from your branch, before merging:
#   config/scripts/cloud-integration/premerge-check.sh
# Merges the current private/cloud/integration into a throwaway worktree with your branch, then requires
#   pnpm typecheck, the full pnpm lint suite (pre-commit hooks only lint staged files), and vitest for the tests your
#   branch touched: changed *.test.ts(x), every test in the folder of each changed source, every test that imports a
#   changed module, and each touched cloud/apps/* package's own suite. PREMERGE_FULL=1 runs the whole vitest suite.
# Prints "premerge OK" only when everything passes. Nothing here reads /tmp state. On macOS (no flock) wrap heavy runs
# as /tmp/vdrv/heavy.sh 'config/scripts/cloud-integration/premerge-check.sh'.
set -euo pipefail
branch=$(git rev-parse --abbrev-ref HEAD)
git fetch -q private +cloud/integration:refs/remotes/private/cloud/integration
base=private/cloud/integration
dir=$(mktemp -d "${TMPDIR:-/tmp}/cloud-premerge-XXXX")
trap 'git worktree remove --force "$dir" >/dev/null 2>&1 || true' EXIT
git worktree add -q --detach "$dir" HEAD
cd "$dir"
git merge -q --no-edit "$base"
pnpm install --frozen-lockfile >/dev/null
pnpm typecheck
pnpm lint

tests=()
if [[ "${PREMERGE_FULL:-}" == 1 ]]; then
  # Full suite (what every build cut runs before its smoke). Slow; use for risky or wide changes.
  node config/scripts/native-build/node-addons/ensure-native-runtime.mjs --runtime=node >/dev/null
  npx vitest run --config config/vitest.config.ts
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
    tests=($(printf "%s\n" "${tests[@]}" | sort -u)) # repo paths have no spaces
    node config/scripts/native-build/node-addons/ensure-native-runtime.mjs --runtime=node >/dev/null
    npx vitest run --config config/vitest.config.ts "${tests[@]}"
  fi
fi
for app in $(git diff --name-only "$base"...HEAD -- cloud/apps | cut -d/ -f1-3 | sort -u); do
  if [[ -d "$app" ]]; then (cd "$app" && npx vitest run); fi
done
if [[ "${PREMERGE_FULL:-}" == 1 ]]; then scope="the full vitest suite"; else scope="${#tests[@]} targeted test file(s)"; fi
echo "premerge OK: $branch merges cleanly into cloud/integration with typecheck, lint and $scope green."
