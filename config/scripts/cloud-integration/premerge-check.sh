#!/usr/bin/env bash
# Gate for merging into cloud/integration (no CI on nwparker/orca-private). Run from your branch, before merging:
#   config/scripts/cloud-integration/premerge-check.sh
# Merges the current private/cloud/integration into a throwaway worktree with your branch, then requires
#   pnpm typecheck, the full pnpm lint suite (pre-commit hooks only lint staged files), and vitest for the tests your
#   branch touched: changed *.test.ts(x) plus the sibling tests of changed sources (foo.ts -> foo.test.ts, foo.*.test.ts),
#   and each touched cloud/apps/* package's own suite.
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
while IFS= read -r file; do
  case "$file" in
    *.test.ts | *.test.tsx) if [[ -f "$file" ]]; then tests+=("$file"); fi ;;
    *.ts | *.tsx)
      stem=${file%.*}
      for candidate in "$stem".test.ts "$stem".test.tsx "$stem".*.test.ts "$stem".*.test.tsx; do
        if [[ -f "$candidate" ]]; then tests+=("$candidate"); fi
      done
      ;;
  esac
done < <(git diff --name-only --diff-filter=AMR "$base"...HEAD -- 'src/*')
if ((${#tests[@]} > 0)); then
  tests=($(printf "%s\n" "${tests[@]}" | sort -u)) # repo paths have no spaces
  node config/scripts/native-build/node-addons/ensure-native-runtime.mjs --runtime=node >/dev/null
  npx vitest run --config config/vitest.config.ts "${tests[@]}"
fi
for app in $(git diff --name-only "$base"...HEAD -- cloud/apps | cut -d/ -f1-3 | sort -u); do
  if [[ -d "$app" ]]; then (cd "$app" && npx vitest run); fi
done
echo "premerge OK: $branch merges cleanly into cloud/integration with typecheck, lint and ${#tests[@]} targeted test file(s) green."
