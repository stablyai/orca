# Auto-refresh on entering the Checks tab

## Problem

The Checks panel fetches on visibility, but those fetches are cache-respecting:

- `CACHE_TTL = 300_000` for PRs and comments.
- `CHECKS_CACHE_TTL = 60_000` for checks.
- `ChecksPanel.tsx` fetches PRs on repo/branch changes without `force`.
- Checks polling and the comments effect also call the store without `force`.

That means entering the Checks tab can render stale PR metadata, a cached `null`
"no PR" result, stale comments, or stale checks. The checks path is partially
protected by a shorter renderer TTL, but the main process also uses `gh api
--cache 60s` for the REST checks endpoint unless `noCache` is set. Manual refresh
already bypasses these renderer and `gh api` caches for the requests it starts.

## Goal

When the user enters the Checks tab, run one freshness check for the active
worktree and force-refresh only when the relevant cache timestamps are older
than a small grace window. "Entering" means:

- opening the right sidebar while the Checks tab is selected;
- switching from another right-sidebar tab to Checks;
- switching active worktree/repo/branch while Checks is already visible.

The refresh must cover PR discovery too, including cached `null`, so a PR opened
outside Orca can appear without waiting up to 5 minutes.

## Non-goals

- Changing the existing polling cadence while the panel stays visible.
- Refreshing on window focus, network reconnect, or arbitrary background events.
- Changing the manual refresh button.
- Prefetching checks for non-active worktrees.
- Adding cross-renderer or cross-window request coordination. Orca currently has
  one live main window; renderer in-flight maps are not a multi-window primitive.

## Design

1. **Entry trigger.** Add an effect in `ChecksPanel.tsx` keyed by:

   ```ts
   const entryKey = isPanelVisible && repo && !isFolder && branch
     ? `${activeWorktreeId ?? ''}::${repo.path}::${branch}`
     : ''
   ```

   Track the last processed visible `entryKey` in a ref. When `entryKey` is empty,
   reset the ref to `''`. When it becomes non-empty and differs from the ref, this
   is an entry. This is required; a `prevKey !== currentKey` check that does not
   reset on hide would miss closing and reopening the same PR.

2. **Grace window.** Define `ENTRY_REFRESH_GRACE_MS = 15_000` in
   `ChecksPanel.tsx`. Select only timestamps, not whole cache records:

   ```ts
   const prFetchedAt = useAppStore(
     (s) => (prCacheKey ? s.prCache[prCacheKey]?.fetchedAt : undefined)
   )
   const checksFetchedAt = useAppStore(
     (s) => prNumber
       ? s.checksCache[`${repo?.path ?? ''}::pr-checks::${prNumber}`]?.fetchedAt
       : undefined
   )
   const commentsFetchedAt = useAppStore(
     (s) => prNumber
       ? s.commentsCache[`${repo?.path ?? ''}::pr-comments::${prNumber}`]?.fetchedAt
       : undefined
   )
   ```

   Missing PR cache is stale. A cached PR value of `null` is still a PR cache
   entry and should be refreshed on entry once outside the grace window. When a
   PR number is known, missing checks/comments timestamps are stale. When no PR is
   known, checks/comments are not relevant yet.

   Run `handleRefresh()` if the oldest relevant timestamp is missing or older
   than `Date.now() - ENTRY_REFRESH_GRACE_MS`; otherwise skip.

3. **Reuse `handleRefresh`, but pass the refreshed head SHA through.** The
   manual refresh flow is the right shape: force `fetchPRForBranch`, then if a
   PR is returned, force checks and comments for the returned PR. Extend
   `fetchChecks()` to accept a `headShaOverride` (or call `fetchPRChecks`
   directly from `handleRefresh`) so the checks request uses
   `refreshedPR.headSha`, not the stale `pr?.headSha` captured before the PR
   refresh completed. This handles PR number changes, cached `null`, and
   external force-pushes correctly.

4. **Reset polling attention state before refresh.** When the entry refresh runs,
   set `pollIntervalRef.current = 30_000` and `prevChecksRef.current = ''` before
   calling `handleRefresh()`. `fetchChecks()` will then write the new signature
   from the forced result.

5. **Do not overstate in-flight behavior.** Current store behavior is:

   - `fetchPRForBranch({ force: true })` bypasses a non-forced in-flight PR
     request and uses a generation guard so the older result cannot overwrite the
     newer cache entry.
   - `fetchPRChecks({ force: true })` and `fetchPRComments({ force: true })` do
     **not** bypass any in-flight request for the same key. If a non-forced poll
     is already in flight, entry refresh will join it and may not pass
     `noCache: true` to the main process.

   Accept that tradeoff for this feature. It avoids duplicate `gh` calls during a
   visible polling race. If strict "entry always bypasses gh cache" semantics are
   required later, change checks/comments in-flight maps to track `{ promise,
   force, generation }` like PRs.

## API cost and feasibility

This is not free. A cold entry refresh can start:

- one PR lookup (`gh:prForBranch`);
- one checks request (`gh:prChecks`);
- one comments request (`gh:prComments`).

`gh:prChecks` usually calls `gh api repos/{owner}/{repo}/commits/{sha}/check-runs`
and uses `--cache 60s` unless forced; if that fails it falls back to `gh pr
checks`, which does not use the `--cache` flag.

`gh:prComments` is heavier than "one GitHub API call": it runs issue comments
REST, review threads GraphQL, and reviews REST in parallel. `noCache` only
removes `--cache 60s` from the REST `gh api` calls; the GraphQL call is always
made.

The 15 s grace window is therefore required, not cosmetic.

## Edge cases

- **Cached no-PR result.** Do not skip just because `prNumber` is null. Refresh
  the PR cache entry on tab entry when its timestamp is outside the grace window.
- **First Checks entry after app start.** Only `prCache` and `issueCache` are
  persisted. `checksCache` and `commentsCache` start empty, so a known PR should
  force checks/comments on entry.
- **Worktree switch while Checks is visible.** Include `activeWorktreeId` in the
  entry key so same repo/branch switches still count as a new entry. The existing
  render-time local reset handles stale title/loading state.
- **Rapid tab toggles.** Hiding the panel resets the processed entry key; showing
  it again re-evaluates timestamps. The grace window suppresses duplicate calls.
- **Concurrent polling tick.** Checks/comments may reuse the in-flight poll
  request instead of forcing a new `noCache` request. This is intentional for now.
- **Conflicting PR refresh.** The existing `mergeable === 'CONFLICTING'` effect
  can still force a PR refresh. Entry refresh may also run, but PR generation
  guards prevent older PR responses from overwriting newer cache entries.
- **PR head changed externally.** `handleRefresh()` must use the refreshed PR
  returned by `fetchPRForBranch` before fetching checks, so checks are requested
  with the current `headSha`.
- **Component unmount mid-fetch.** The comments auto-fetch guards stale
  responses; the checks fetch path and `handleRefresh()` do not cancel local
  setters. This feature should keep that behavior unless tests expose a warning
  or stale-state regression.
- **SSH / remote repo.** No path manipulation or platform-specific shortcut code
  is needed. The same IPC-backed `gh` path is used.

## Rollout

1. Add timestamp selectors, `ENTRY_REFRESH_GRACE_MS`, and the entry effect in
   `ChecksPanel.tsx`.
2. Keep `handleRefresh()` as the single refresh implementation.
3. Add `ChecksPanel.test.tsx` if absent. Cover stale PR/null cache refreshes,
   fresh-within-grace skips, known PR with missing checks/comments refreshes,
   hidden panel no-op, and hide/show same PR re-evaluation.
4. Run `pnpm typecheck && pnpm lint`.
