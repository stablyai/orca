# Fork PR and Check Detection

## Problem

Fork workflows push branches to `origin` but open PRs in the base repo (`upstream`).
Current GitHub PR/check code assumes the PR lives in `origin`:

- `getOwnerRepo` resolves only `origin` in `src/main/github/gh-utils.ts`.
- `getPRForBranch` uses that repo for linked-number and branch lookups in
  `src/main/github/client.ts`.
- `getPRChecks` uses that repo for both REST check-runs and `gh pr checks` in
  `src/main/github/client.ts`.
- Renderer check fetches are keyed by `repoId + prNumber`; they do not include
  PR repository identity, so repo retargets can reuse stale/inflight data.

Result: when `origin` is a fork, Orca often shows no PR/checks even when an
upstream PR exists.

## Root Cause

The code conflates:

- head repo (where branch is pushed), and
- PR object repo (where the PR number, checks, comments live).

Forks split these.

## Non-goals

- No new user setting for PR/check source selection.
- No change to push target or PR creation flow.
- No redesign of issues/work-items source preference.
- No mandatory network in tests.

## Required Design Changes

1. Extend `PRInfo` with repo identity.
   - Add optional `prRepo: { owner: string; repo: string }`.
   - Add optional `headRepo: { owner: string; repo: string }`.
   - Keep optional for backward-compatible cached objects.

2. Add PR repo candidate resolution in `gh-utils`.
   - Resolve `upstream` and `origin` via `getOwnerRepoForRemote`.
   - Candidate order: `upstream`, then `origin`.
   - De-dupe by case-insensitive `owner/repo`.
   - Return resolved `origin` separately for `headRepo`.

3. Make `getPRForBranch` candidate-aware.
   - Preserve current algorithm shape: linked PR number first, branch lookup second,
     stale-linked fallback last.
   - Run linked-number lookup across candidates in order.
   - For branch lookup, use REST exact head match per candidate:
     `repos/{candidate}/pulls?head={headOwner}:{branch}&state=all&per_page=1`.
   - Keep `gh pr list --head` only as fallback when `headRepo` is unknown.
   - Preserve existing external behavior: `getPRForBranch` still returns `null`
     on failure (no new throw behavior to callers/IPC).
   - Return matched `prRepo` and resolved `headRepo` in `PRInfo`.

4. Thread `prRepo` through checks APIs.
   - Add optional `prRepo` to:
     - main `getPRChecks`
     - IPC `gh:prChecks`
     - preload bridge + `api-types`
     - runtime `getRepoPRChecks`
     - renderer `fetchPRChecks`
   - Use `prRepo` for both check-runs REST route and `gh pr checks --repo`.
   - If absent, keep origin fallback for old cache entries.

5. Fix check-keying and stale-result guards.
   - Pass `pr?.prRepo` from `ChecksPanel` into `fetchPRChecks`.
   - Include PR repo identity in:
     - checks cache key
     - checks inflight dedupe key
     - checks async result key (`checksPanelAsyncResultKey`)
   - Normalize key identity to lowercase `owner/repo` to avoid duplicate cache
     buckets for case-only slug differences.
   - Recommended suffix: `pr-checks::{owner}/{repo}::{prNumber}`.

6. Define candidate error handling.
   - Not found / empty: continue to next candidate.
   - Permission / rate / transient errors: record and continue.
   - Internal selection may classify hard failures, but exported
     `getPRForBranch` semantics remain `PRInfo | null` (swallow + `null`).
   - No match remains `null`; checks fetch failure remains `[]` + warning.

7. Add remote-mutation cache invalidation.
   - `getOwnerRepoForRemote` caches remote resolution indefinitely today.
   - When remotes change externally (`git remote set-url`, add/remove upstream),
     candidate resolution can stay stale.
   - Add bounded TTL for `getOwnerRepoForRemote` cache entries (including
     cached `null`) so external remote URL mutations self-heal without requiring
     a dedicated invalidation signal.

## Edge Cases To Cover

- `origin` and `upstream` resolve to same GitHub slug: query once.
- `upstream` exists but non-GitHub: ignore it.
- Same branch name in many forks: only exact `head={originOwner}:{branch}` is valid.
- Linked PR number exists only in one candidate repo.
- Linked PR exists but points to stale head SHA.
- Detached HEAD / empty branch: skip branch lookup.
- PR retarget/reopen changes PR repo while `prNumber` stays same: new repo-aware
  keys must force a fresh checks read and reject stale async commits.
- Cached PR without `prRepo`: origin fallback still works.
- SSH repos: keep `gh` cwd-less execution and explicit `--repo`/REST paths.

## Feasibility Notes

- No single GitHub call resolves both “which repo owns the PR” and “checks for this
  branch in fork workflows” reliably; candidate probing is required.
- Existing REST endpoints already support the needed exact match and check-runs queries.
- Latency cost is bounded by at most one extra candidate in the common fork case.

## Tests

- Fork PR lookup resolves upstream PR from branch.
- Linked PR number lookup across candidates.
- Exact-head collision case (`head={originOwner}:{branch}`).
- `prChecks` uses explicit `prRepo` when present.
- Check cache/inflight key isolation across PR repo changes.
- Async-result stale rejection when PR repo changes mid-flight.
- Remote URL mutation invalidates cached remote-owner resolution.
