#!/usr/bin/env bash
# Gate for merging into cloud/integration (no CI on nwparker/orca-private): run from your branch's clone.
# Merges the current private/cloud/integration into a throwaway worktree with your branch, then requires
# typecheck, the full lint suite (pre-commit hooks only lint staged files) and the tests your branch changed.
set -euo pipefail
branch=$(git rev-parse --abbrev-ref HEAD)
git fetch -q private +cloud/integration:refs/remotes/private/cloud/integration
dir=$(mktemp -d "${TMPDIR:-/tmp}/cloud-premerge-XXXX")
trap 'git worktree remove --force "$dir" >/dev/null 2>&1 || true' EXIT
git worktree add -q --detach "$dir" HEAD
cd "$dir"
git merge -q --no-edit private/cloud/integration
pnpm install --frozen-lockfile >/dev/null
pnpm typecheck
pnpm lint
tests=$(git diff --name-only --diff-filter=AM private/cloud/integration...HEAD -- 'src/*.test.ts' 'src/*.test.tsx' | tr '\n' ' ')
if [[ -n "$tests" ]]; then
  node config/scripts/native-build/node-addons/ensure-native-runtime.mjs --runtime=node >/dev/null
  npx vitest run --config config/vitest.config.ts $tests
fi
for app in $(git diff --name-only private/cloud/integration...HEAD -- cloud/apps | cut -d/ -f1-3 | sort -u); do
  (cd "$app" && npx vitest run)
done
echo "premerge OK: $branch merges cleanly into cloud/integration with typecheck, lint and tests green."
