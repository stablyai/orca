#!/usr/bin/env bash
# Rebuild cloud/integration (pushed only to nwparker/orca-private) from scratch:
#   stablyai/orca main
#   + merge nwparker/orca-private nwparker/accounts-billing, nwparker/vercel-driver
#   + merge open upstream PR branches still under review (stablyai/orca nwparker/agent-host-sign-in #40228,
#     nwparker/agent-api-keys #40303); drop each from STACKED once it lands on main
#   + cherry-pick every "chore(cloud-integration)" commit already on cloud/integration (build defaults, this script).
# Never based on stablyai/orca-private (Bots). git rerere replays conflict resolutions made before in this clone.
# Conflict policy: billing files (cloud/apps/billing, cloud/docs/accounts-billing-design.md, src/main/billing,
# src/renderer/src/components/billing, src/shared/orca-billing.ts, billing keys in en.json) keep accounts-billing
# ("ours"); vercel-driver carries an older billing snapshot. Elsewhere keep both sides.
#
# Usage (from a clone of stablyai/orca with remote `private` = nwparker/orca-private, never an Orca worktree):
#   config/scripts/cloud-integration/sync-cloud-integration.sh       # builds local branch cloud/integration-next
#   on conflict: resolve, `git add -A && git commit --no-edit` (or `git cherry-pick --continue`), rerun with --resume
#   pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint
#   git push --force-with-lease=cloud/integration private cloud/integration-next:cloud/integration
set -euo pipefail

PRIVATE_BRANCHES=(${PRIVATE_BRANCHES:-nwparker/accounts-billing nwparker/vercel-driver})
STACKED=(${STACKED:-nwparker/agent-host-sign-in nwparker/agent-api-keys})

git remote get-url private >/dev/null 2>&1 || git remote add private https://github.com/nwparker/orca-private.git
git config rerere.enabled true
git config rerere.autoupdate true
git fetch -q origin main
for b in "${STACKED[@]}"; do git fetch -q origin "+$b:refs/remotes/origin/$b"; done
for b in "${PRIVATE_BRANCHES[@]}"; do git fetch -q private "+$b:refs/remotes/private/$b"; done
git fetch -q private +cloud/integration:refs/remotes/private/cloud/integration 2>/dev/null || true

[[ "${1:-}" == --resume ]] || git checkout -q -B cloud/integration-next origin/main

for ref in "${PRIVATE_BRANCHES[@]/#/private/}" "${STACKED[@]/#/origin/}"; do
  git merge-base --is-ancestor "$ref" HEAD && continue
  git merge --no-ff --no-edit "$ref" || {
    echo "Conflict merging $ref. Resolve (policy above), git add -A && git commit --no-edit, rerun with --resume." >&2
    exit 1
  }
done

if git rev-parse -q --verify private/cloud/integration >/dev/null; then
  for c in $(git log --reverse --no-merges --format=%H --grep='^chore(cloud-integration)' origin/main..private/cloud/integration); do
    git log --format=%s origin/main..HEAD | grep -qxF "$(git log -1 --format=%s "$c")" && continue
    git cherry-pick "$c" || { echo "Conflict re-applying $c; resolve, git cherry-pick --continue, rerun with --resume." >&2; exit 1; }
  done
fi
echo "cloud/integration-next ready at $(git rev-parse --short HEAD) on stablyai/orca main $(git rev-parse --short origin/main)."
