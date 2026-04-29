# Issue-Source Indicator and Error Surfacing

**Status:** Ready to implement
**Parent design doc:** `/Users/thebr/orca/workspaces/orca/review-1076/docs/upstream-issue-source-design.md` (§§2–3, plus the "Implementation spec: Feature 1" section)
**Related:** PR #1076 (merged), Issue #923

## Context

PR #1076 routes GitHub **issue** operations to the `upstream` remote when it exists and keeps **PR** operations on `origin`. The routing is correct and closes #923 for fork contributors — but the PR merged without two pieces the design doc considered merge-blockers:

1. **A visible indicator** showing which repo issues are coming from.
2. **An error surface** when the upstream fetch fails — currently `listIssues` collapses to `[]` via a bare `catch`, making a 403 on a private upstream indistinguishable from an empty backlog.

This worktree implements both. They share a surface (Tasks-view header / empty-state region) and both need the resolved `OwnerRepo` slug from the same IPC round-trip, so they ship together.

### Why this matters (condensed from the parent doc)

- Without the indicator, #1076 is "a convention-based heuristic masquerading as a correctness fix" — exactly what PR #1186 rejected for base-refs. The indicator is what makes the heuristic legitimately different from #1186's rejected alternative, because the self-announcing property of wrong issue-source only functions when the source is shown.
- Without error surfacing, a fork contributor without read access to a private upstream parent sees "No issues" — a correctness regression introduced by the new default. A *silent fallback to origin* is rejected because it re-creates the silent-source-switch pattern #1186 warned against, just one level deeper.

## Ground truth (verified against current `main`)

- Owner/repo resolution is in `src/main/github/gh-utils.ts`:
  - `getOwnerRepo(repoPath)` — reads `origin` (line 109).
  - `getIssueOwnerRepo(repoPath)` — reads `upstream` first, falls back to `origin` (line 113).
  - Both return `OwnerRepo | null` where `OwnerRepo = { owner: string; repo: string }`.
- **The error-swallow site is `src/main/github/issues.ts:74`** — `} catch { return [] }` in `listIssues`. This is the specific line this feature changes.
- `classifyGhError()` already exists in `gh-utils.ts:41` and returns typed errors: `permission_denied | not_found | validation_error | rate_limited | network_error | unknown`. The error-banner copy should consume this rather than stringifying raw stderr.
- IPC handler lives at `src/main/ipc/github.ts` (not `src/ipc/github.ts`).
- Preload types live at `src/preload/api-types.ts` (not `api-types.d.ts`).
- Work-items state in the renderer is `src/renderer/src/store/slices/github.ts`. It already defines `CacheEntry<T> = { data: T | null; fetchedAt: number }` at the top — extend this.
- Tasks view: `src/renderer/src/components/TaskPage.tsx`.
- Detail view: `src/renderer/src/components/GitHubItemDialog.tsx`.
- Composer: `src/renderer/src/hooks/useComposerState.ts` is the hook; render sites consume it.
- Dashboard: `src/renderer/src/components/dashboard/AgentDashboard.tsx` also renders work-items rows — **the indicator must appear here too**, or the omission must be justified.

## Spec

### 1. Indicator

**Copy:** `Issues from {owner}/{repo}` — rendered near the filter row in the Tasks view header.

Rules:

- **Host-agnostic.** Show owner/repo slug only. Never "GitHub". Never the remote name (not "upstream", not "origin"). This is the parent doc's §2 requirement — the indicator must not claim anything about host support, and remote names are a local convention we shouldn't leak.
- **Suppression rule:** hide the indicator when issue-source and PR-source resolve to the **same** `{owner}/{repo}`. Check by deep-equality of the resolved `OwnerRepo` objects — not by "does `upstream` exist?" The case where `upstream` exists but is a non-GitHub remote (so `getIssueOwnerRepo` falls back to origin anyway) must also suppress. No information to convey when the two sides resolve to the same slug.
- **Loading state:** hidden until the resolved slug is known (one IPC round-trip). No skeleton — a skeleton would add chrome for a sub-second gap. The work-items list renders its own loading UI independently.
- **Known limitation (document, don't fix):** remotes mutated mid-session don't invalidate the indicator until app restart, because the underlying `ownerRepoCache` in `gh-utils.ts` is process-lifetime. Mention this in the commit body; do not attempt to fix here.

**Surfaces:**

1. **Tasks view** (`TaskPage.tsx`) — primary surface. Header, near the filter row.
2. **Create Issue composer** — mirror the indicator where the composer is rendered. This is non-negotiable: User D's regression (filing personal TODOs against a fork when issues now route to upstream) is specifically about the composer. A user pausing before clicking submit — "wait, am I about to file this on `stablyai/orca`? do I have write access?" — is the whole point. Find the composer render site by tracing consumers of `useComposerState.ts`.
3. **AgentDashboard** (`AgentDashboard.tsx`) — this dashboard also renders work-items rows. Add the indicator there too. If you find a principled reason to omit (e.g., the rows are already slug-annotated per-item so a header-level indicator is redundant), document the reasoning in the commit rather than silently skipping.
4. **GitHubItemDialog** (`GitHubItemDialog.tsx`) — detail view header. Weaker requirement (the issue URL is already visible), but include it for consistency.

### 2. Error banner

**Fix the swallow site at `issues.ts:74`.** `listIssues` must propagate errors instead of collapsing to `[]`. The callers in `client.ts` (`listWorkItems`, `listRecentWorkItems`, `listQueriedWorkItems`) need enough information to surface the failure to the UI.

Do **not** silent-fallback to origin on upstream failure. Per parent doc §3: rejected because it re-creates the silent-source-switch pattern at a deeper layer.

**Error envelope:**

Extend `CacheEntry<T>` in `src/renderer/src/store/slices/github.ts`:

```ts
import type { ClassifiedError } from '../../../../shared/types'

export type CacheEntry<T> = {
  data: T | null
  fetchedAt: number
  error?: ClassifiedError & { source: { owner: string; repo: string } }
}
```

`ClassifiedError` is exported from `src/shared/types.ts` (already present).

**Partial-failure rule:** when one source fails and the other succeeds (e.g., upstream issues 403 but origin PRs fine), the work-items cache should hold the *successful* data **and** the error for the failing side. The UI renders partial results with a banner, not an empty state. Do not fail the whole request on one-sided failure.

**UI:** inline banner in the Tasks view replacing the empty state when `error` is set and `data` is empty. Copy:

```
Couldn't load issues from {owner}/{repo} — {classifiedError.message}. [Retry]
```

`[Retry]` re-invokes the fetch with `force: true` (the github slice already has a `force` option on inflight requests — see `inflightPRRequests` shape around line 32).

When `error` is set *and* `data` has items (partial results from another source), render the banner above the list without replacing it.

**PR-side failures are out of scope for this banner.** Feature 1 is specifically about the new class of silent wrongness introduced by routing issues to upstream. PR fetch failures existed before #1076 and their existing handling is out of scope; conflating them would grow the change and dilute the signal.

### 3. IPC plumbing

Extend the return envelope of `gh:listWorkItems` (in `src/main/ipc/github.ts`) to include source metadata:

```ts
type ListWorkItemsResult = {
  items: GitHubWorkItem[]
  sources: {
    issues: OwnerRepo | null
    prs: OwnerRepo | null
  }
  errors?: {
    issues?: ClassifiedError
    prs?: ClassifiedError // only populated if it fits the same "new silent wrongness" pattern — usually omit
  }
}
```

Piggyback on the existing IPC rather than adding a new `gh:resolveWorkItemSources` — no new round-trips.

Update `src/preload/api-types.ts` and `src/preload/index.ts` to reflect the new envelope.

Do the same for `gh:listRecentWorkItems`, `gh:listQueriedWorkItems`, and `gh:countWorkItems` as needed — whichever surfaces read from `listIssues`.

### 4. Files to touch

**Main:**
- `src/main/github/issues.ts` — change the catch at line 74 (and likely similar sites — audit the file) to propagate a `ClassifiedError` instead of returning `[]`. Use `classifyGhError(stderr)` from `gh-utils.ts`. Consider a new return type like `IssueListResult = { items: IssueInfo[]; error?: ClassifiedError }` so partial success is representable.
- `src/main/github/client.ts` — thread source `OwnerRepo`s through `listWorkItems` and siblings. Handle per-source errors: one-sided failure returns partial data plus the error for the failing side.
- `src/main/ipc/github.ts` — extend return envelopes as above.

**Preload:**
- `src/preload/index.ts`, `src/preload/api-types.ts` — type plumbing.

**Renderer:**
- `src/renderer/src/store/slices/github.ts` — widen `CacheEntry`; track per-side error state; store resolved sources on cache entries.
- `src/renderer/src/components/TaskPage.tsx` — render indicator in header; render error banner in empty-state region; render banner-above-list when partial.
- `src/renderer/src/components/dashboard/AgentDashboard.tsx` — render indicator (no banner required here — it's a dashboard summary).
- `src/renderer/src/components/GitHubItemDialog.tsx` — source repo in detail header.
- `src/renderer/src/hooks/useComposerState.ts` — expose the resolved issue-source slug to composer consumers.
- Composer render site(s) — trace consumers of `useComposerState.ts` and render the indicator at each Create Issue surface.

### 5. Tests

- **Extend `src/main/github/client-issue-source.test.ts`:** add a case where `listIssues` encounters a 403; assert that the `ClassifiedError` reaches the IPC return envelope rather than being swallowed. Confirm the `sources` field is populated correctly on both success and partial failure.
- **New case in `src/main/github/client-work-items.test.ts`** (already exists per PR #1076): partial-failure scenario — upstream issues fail, origin PRs succeed, result includes both the PR data and the issue-side error.
- **Renderer test** (colocated with `github.ts` slice or `TaskPage.test.tsx` if one exists): banner renders with retry when the slice has an `error` field; retry triggers a `force: true` re-fetch. If no TaskPage test file exists, a unit test on the slice is sufficient.
- **Suppression rule test:** indicator is hidden when `sources.issues` and `sources.prs` deep-equal; visible when they differ; hidden when either is `null`.

### 6. Out of scope

- **Fixing `ownerRepoCache` staleness.** Parent doc §5 calls this a documented v1 limitation. The indicator-goes-stale-until-restart behavior is acceptable in lockstep with the routing going stale until restart; fixing one without the other would produce a worse state.
- **PR-side error handling.** Only the new-class-of-silent-wrongness introduced by #1076 is in scope.
- **Per-repo selector (Feature 2).** Separate worktree.
- **Non-GitHub hosts.** Copy is slug-only and host-agnostic, which is sufficient; no GitLab/Bitbucket backing required.

## Acceptance criteria

1. Indicator renders on Tasks view, Create Issue composer, and AgentDashboard when issue-source and PR-source slugs differ. Hidden otherwise. Host-agnostic copy.
2. `issues.ts:74` no longer swallows errors. A 403 on a private upstream produces an inline banner with retry — not an empty list.
3. Partial success (upstream issues fail, origin PRs succeed) renders origin PRs with a banner above the list, not an empty state.
4. Retry button re-invokes the fetch with `force: true` and clears the banner on success.
5. `pnpm typecheck`, `pnpm lint`, and relevant vitest files all pass:
   - `pnpm exec vitest run --config config/vitest.config.ts src/main/github/ src/renderer/src/store/slices/`
6. No regression in existing PR/issue queries (User A — single-remote, no upstream — sees zero change).

## Commit shape

Two commits, in order, each with a rationale paragraph in the body:

1. `fix(github): surface upstream fetch errors instead of returning empty list` — the catch-site fix, IPC envelope extension, slice widening, and error-banner rendering. Lands the error surface first so indicator work can rely on the shared `sources` field.
2. `feat(github): show source repo on Tasks view and Create Issue composer` — the indicator rendering across all four surfaces.

If the work ends up entangled, a single commit is fine — flag it in the PR description.
