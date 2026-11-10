#!/usr/bin/env bash
# Move cloud/integration (on `private` = nwparker/orca-private) forward. Other workstreams branch from it and merge
# into it, so it is NEVER rebuilt or force-pushed: this script only merges new commits from its sources.
#   stablyai/orca main ($UPSTREAM, default origin; set UPSTREAM=stably in clones that name it so)
#   + PRIVATE_BRANCHES on nwparker/orca-private (none by default: accounts-billing and vercel-driver are retired;
#     accounts-billing was rewritten after its content landed here, so merging its old tips would re-add history)
#   + open upstream PR branches stacked in while under review: nwparker/agent-host-sign-in (#40228),
#     nwparker/agent-sign-in-followups (#40283, stacked on #40228), nwparker/agent-api-keys (#40303).
#     Once a PR lands, main brings it; drop it from STACKED. A source force-pushed (rebased) still merges: resolve to
#     its new structure and never re-add what it removed (see the vercel-driver rebase merge).
# Never based on stablyai/orca-private (Bots). git rerere replays conflict resolutions made before in this clone.
# Conflict policy: billing files (cloud/apps/billing, cloud/docs/accounts-billing-design.md, src/main/billing,
# src/renderer/src/components/billing, src/shared/orca-billing.ts, billing keys in en.json) keep accounts-billing;
# vercel-driver carries an older billing snapshot. Elsewhere keep both sides.
#
# Usage (clone of stablyai/orca, remote `private`). Nothing here reads /tmp. In a worktree where cloud/integration is
# checked out elsewhere, set LOCAL_BRANCH to a scratch branch name and push it with HEAD:cloud/integration.
#   config/scripts/cloud-integration/sync-cloud-integration.sh
#   on conflict: resolve, `git add -A && git commit --no-edit`, rerun (already-merged sources are skipped)
#   then: pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && targeted vitest
#   (or run config/scripts/cloud-integration/premerge-check.sh)
#   git push private "$LOCAL_BRANCH":cloud/integration   # fast-forward only; if rejected, rerun (someone merged)
set -euo pipefail

UPSTREAM=${UPSTREAM:-origin}
LOCAL_BRANCH=${LOCAL_BRANCH:-cloud/integration}
PRIVATE_BRANCHES=(${PRIVATE_BRANCHES:-})
STACKED=(${STACKED:-nwparker/agent-host-sign-in nwparker/agent-sign-in-followups nwparker/agent-api-keys})

git remote get-url private >/dev/null 2>&1 || git remote add private https://github.com/nwparker/orca-private.git
git config rerere.enabled true
git config rerere.autoupdate true
git fetch -q "$UPSTREAM" main
for b in "${STACKED[@]}"; do git fetch -q "$UPSTREAM" "+$b:refs/remotes/$UPSTREAM/$b"; done
for b in ${PRIVATE_BRANCHES[@]+"${PRIVATE_BRANCHES[@]}"}; do git fetch -q private "+$b:refs/remotes/private/$b"; done
git fetch -q private +cloud/integration:refs/remotes/private/cloud/integration

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "Working tree has changes; commit or set them aside first." >&2; exit 1
fi
# Keep local unpushed commits: fast-forward or merge the remote tip in, never reset onto it.
if git rev-parse -q --verify "refs/heads/$LOCAL_BRANCH" >/dev/null; then
  git checkout -q "$LOCAL_BRANCH"
  git merge --no-edit -q private/cloud/integration
else
  git checkout -q -b "$LOCAL_BRANCH" private/cloud/integration
fi

for ref in "$UPSTREAM/main" ${PRIVATE_BRANCHES[@]+"${PRIVATE_BRANCHES[@]/#/private/}"} "${STACKED[@]/#/$UPSTREAM/}"; do
  git merge-base --is-ancestor "$ref" HEAD && continue
  git merge --no-ff --no-edit -m "Merge $ref into cloud/integration" "$ref" || {
    echo "Conflict merging $ref. Resolve (policy above), git add -A && git commit --no-edit, rerun." >&2
    exit 1
  }
done
echo "cloud/integration at $(git rev-parse --short HEAD), $(git rev-list --count private/cloud/integration..HEAD) new commit(s) over private. Verify, then: git push private $LOCAL_BRANCH:cloud/integration"
