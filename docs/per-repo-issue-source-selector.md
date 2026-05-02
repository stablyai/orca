# Per-Repo Issue-Source Selector

**Status:** Ready to implement
**Parent design doc:** `/Users/thebr/orca/workspaces/orca/review-1076/docs/upstream-issue-source-design.md` (§4, plus "Implementation spec: Feature 2")
**Related:** PR #1076 (merged), Issue #923, sibling worktree `feature-1-source-indicator-and-errors`

## Context

PR #1076 auto-prefers `upstream` for issue queries when the remote exists. This is right for the modal fork contributor (User B in the parent doc) but silently wrong for two regression cases that are now live in merged code:

- **User C** — has `upstream` for unrelated reasons (archived mirror, stale remote, unrelated parent). Their Tasks view silently rerouted to a different repo. Their only non-destructive escape today is `git remote remove upstream`, which undoes PR #1186's base-ref discovery win.
- **User D** — fork contributor who wants to file a personal TODO on *their fork's* tracker. After #1076, every Create Issue lands on upstream with no in-app path back.

This worktree implements the per-repo override selector that fixes both — a user-facing segmented control `Upstream | Origin` in the Tasks view and mirrored in the Create Issue composer, with the choice persisted per registered repo.

### Why per-repo, not per-worktree or global

- **Per-worktree** conflates issue-source (a property of the fork relationship, "what's the canonical repo for this project") with base-ref pinning (per-checkout). The parent doc considered and deferred per-worktree pending a possible unified fork-preference setting; per-repo is the right default now.
- **Global** would immediately collide — a user with Users A, B, and C repos side-by-side needs different answers per repo.

### Why three states (`'auto' | 'upstream' | 'origin'`) not two

The UI is a two-pill segmented control. But storage needs three states because "the user explicitly chose upstream" must be distinguishable from "the heuristic happens to resolve to upstream right now." Otherwise, a remote-topology change (someone removes `upstream`, or adds one later) would silently move a user's preference — exactly the silent-source-switch pattern the parent doc and #1186 reject.

- `'auto'` (or `undefined`) — honor the heuristic from PR #1076 (`getIssueOwnerRepo`: upstream-if-exists, else origin). This is the initial state for every repo.
- `'upstream'` — user explicitly chose upstream. Wins over heuristic and over future remote-topology changes.
- `'origin'` — user explicitly chose origin. Same precedence.

The segmented control shows two pills; `'auto'` is the *absence* of explicit choice, rendered as the heuristic-picked pill highlighted. Clicking either pill writes the explicit preference.

## Ground truth (captured before implementation)

> Line numbers and file-state claims below are pre-implementation snapshots. The
> shipped code lives in `src/main/persistence.ts`, `src/main/github/gh-utils.ts`,
> `src/main/ipc/github.ts`, `src/preload/api-types.ts`, `src/preload/index.ts`,
> `src/renderer/src/components/TaskPage.tsx`,
> `src/renderer/src/components/github/IssueSourceSelector.tsx`, and
> `src/renderer/src/store/slices/github.ts`. `updateRepo`'s `Pick` was extended
> to include `issueSourcePreference`. Composer integration lives directly in
> `TaskPage.tsx`, not `useComposerState.ts`.

- Persistence lives in `src/main/persistence.ts` — a **single file exporting `class Store`**, not a directory. Earlier sketches had the path wrong.
- `Repo` is defined in `src/shared/types.ts`. It already carries per-repo metadata: `worktreeBaseRef`, `hookSettings`, `displayName`, `badgeColor`, `kind`, `connectionId`. Adding a new optional field follows the same pattern.
- The `updateRepo` entry in `persistence.ts` uses `Pick<Repo, 'displayName' | 'badgeColor' | 'hookSettings' | 'worktreeBaseRef' | 'kind'>` — extend this Pick to include the new field.
- `Repo.id` is the stable registered-repo id and the correct persistence key.
- Owner/repo resolution: `src/main/github/gh-utils.ts` — `getOwnerRepo`, `getIssueOwnerRepo`, `getOwnerRepoForRemote` (exported; the primitive we need).
- IPC handler: `src/main/ipc/github.ts`.
- Preload types: `src/preload/api-types.ts`.
- Tasks view: `src/renderer/src/components/TaskPage.tsx`.
- Work-items cache: `src/renderer/src/store/slices/github.ts` — invalidation logic lives here.

## Spec

### 1. Storage shape

Add a new field to `Repo` in `src/shared/types.ts`:

```ts
export type IssueSourcePreference = 'upstream' | 'origin' | 'auto'

export type Repo = {
  // ...existing fields
  issueSourcePreference?: IssueSourcePreference // undefined == 'auto'
}
```

`undefined` and `'auto'` are treated identically at read time. Default writers (e.g., `addRepo`) leave it undefined rather than writing `'auto'` — keeps existing persisted state forward-compatible and avoids churning every repo record on first run.

### 2. Resolution helper

Add a new function to `src/main/github/gh-utils.ts`, adjacent to `getIssueOwnerRepo`:

```ts
export async function resolveIssueSource(
  repoPath: string,
  preference: IssueSourcePreference | undefined
): Promise<{ source: OwnerRepo | null; fellBack: boolean }> {
  if (preference === 'upstream') {
    const upstream = await getOwnerRepoForRemote(repoPath, 'upstream')
    if (upstream) return { source: upstream, fellBack: false }
    // Preferred upstream no longer exists — fall back, signal for toast
    return { source: await getOwnerRepoForRemote(repoPath, 'origin'), fellBack: true }
  }
  if (preference === 'origin') {
    return { source: await getOwnerRepoForRemote(repoPath, 'origin'), fellBack: false }
  }
  // 'auto' or undefined
  return { source: await getIssueOwnerRepo(repoPath), fellBack: false }
}
```

Do **not** delete `getIssueOwnerRepo` — it stays as the right primitive for auto-mode and for any non-preference-aware caller (e.g., type-hinted work-item-details lookups).

`fellBack: true` is the signal for the one-time toast "Your preferred source (upstream) is no longer configured for this repo; using origin." Fire-and-forget; no modal.

The preference parameter has to be passed in because `gh-utils.ts` doesn't import the `Store`. Callers in `client.ts` / `issues.ts` look up the `Repo` by `repoPath` (or better: by `repoId`) and pass `repo.issueSourcePreference` through.

### 3. Call-site migration

Swap call sites from `getIssueOwnerRepo(repoPath)` to `resolveIssueSource(repoPath, preference).source`:

- `src/main/github/issues.ts` — `listIssues`, `createIssue`, `updateIssue`, `addIssueComment`, `listLabels`, `listAssignableUsers`, and any other issue-side callers. Each needs access to the preference.
- `src/main/github/client.ts` — `listWorkItems`, `listRecentWorkItems`, `listQueriedWorkItems`, `countWorkItems` for the issues side of the fan-out.

**Do not migrate** `src/main/github/work-item-details.ts`'s typed lookups. The type hint there is about resolving a known-issue vs known-PR (preventing origin PR #42 from resolving to an unrelated upstream issue #42), which is orthogonal to user preference. Leave those on `getIssueOwnerRepo` / `getOwnerRepo` as #1076 wired them.

To thread the preference through, add a `preference?: IssueSourcePreference` parameter to each affected public function, or resolve it once in the IPC layer from the registered `Repo` and pass it down. The latter is cleaner — a single lookup in `src/main/ipc/github.ts` handlers, then pass through.

### 4. Persistence

Extend the `updateRepo` entry in `src/main/persistence.ts` to include `issueSourcePreference` in the Pick:

```ts
updateRepo(id: string, patch: Partial<Pick<Repo, 'displayName' | 'badgeColor' | 'hookSettings' | 'worktreeBaseRef' | 'kind' | 'issueSourcePreference'>>): void
```

Writing `undefined` clears the preference (reset to auto). As shipped, `updateRepo` has an explicit delete branch for this field — `if ('issueSourcePreference' in updates && updates.issueSourcePreference === undefined)` removes the key from the record rather than relying on shallow-merge semantics. This keeps `undefined` and absent indistinguishable at read time (both mean auto) without introducing a `null` sentinel.

### 5. IPC

As shipped: preference reads come off the `Repo` record already delivered by
`repos:list`; writes go through the existing generic `repos:update` IPC
(`src/main/ipc/repos.ts`), which was extended to accept `issueSourcePreference`
in its `Pick`. This keeps a single write path, emits the `repos:changed`
broadcast for free, and avoids two channels racing on the same field.

Update `src/preload/api-types.ts` to reflect the extended update surface. (`src/preload/index.ts` passes `repos:update` args through unchanged, so no edits are needed there.)

### 6. UI: segmented control

**Location:** Tasks-view header, adjacent to where the indicator from the sibling worktree (`feature-1-source-indicator-and-errors`) renders. If Feature 1 has not landed when this work starts, render the selector alone in the header — the indicator work will be merged in later.

**Shape:** two-pill segmented control, `Upstream | Origin`.

**Active-pill rules:**

- If `preference === 'upstream'` or `preference === 'origin'`: highlight that pill.
- If `preference === 'auto'` or undefined: highlight whichever pill the heuristic (`getIssueOwnerRepo`) currently resolves to. This means the user sees the correct active state without having to understand "auto." Clicking either pill writes the explicit preference.

**Disabled state:** when upstream and origin resolve to the same slug (no upstream remote, or upstream is non-GitHub), the selector is meaningless. Hide it entirely, or render it disabled with a tooltip — match whatever the surrounding UI does for "nothing to toggle."

**Mirror in composer:** the Create Issue composer must have the same segmented control. This is non-negotiable per the parent doc — User D's regression is specifically about filing against the wrong repo, and the composer is where "which repo is this actually landing on?" bites. As shipped, the composer-mirrored selector lives directly in `TaskPage.tsx`'s new-issue dialog (the dialog's `DialogHeader` renders `IssueSourceSelector` as a sibling of `DialogDescription` — nesting the selector inside `DialogDescription`'s `<p>` would produce invalid HTML).

**Cache invalidation on change:** when the user flips the selector, the work-items cache in `src/renderer/src/store/slices/github.ts` for that repo must be invalidated and re-fetched against the new source. Don't just re-render with stale cached data from the other source.

### 7. Toast for fallback

When `resolveIssueSource` returns `fellBack: true` (user preferred `'upstream'` but the remote is gone), surface a one-time toast:

> Your preferred issue source (upstream) is no longer configured for `{origin-owner}/{origin-repo}`. Using origin.

Use the existing toast mechanism (`sonner` is already in use — see `TaskPage.tsx:23`). Fire once per session per repo; don't re-toast on every refresh. Do **not** auto-reset the preference — the user might re-add `upstream` later and expect it to pick up again.

### 8. Files to touch

**Shared:**
- `src/shared/types.ts` — add `IssueSourcePreference` type and the optional `Repo` field.

**Main:**
- `src/main/persistence.ts` — extend `updateRepo` Pick with `issueSourcePreference` and add the "reset to auto drops the key" delete branch.
- `src/main/github/gh-utils.ts` — new `resolveIssueSource` helper.
- `src/main/github/client.ts`, `src/main/github/issues.ts` — migrate call sites.
- `src/main/ipc/github.ts` — IPC handlers read `repo.issueSourcePreference` off the registered `Repo` and thread it into the list/create paths (`listIssues`, `createIssue`, `listWorkItems`, `countWorkItems`, `listLabels`, `listAssignableUsers`).
- `src/main/ipc/repos.ts` — extend `repos:update` to accept `issueSourcePreference`.

**Preload:**
- `src/preload/api-types.ts`, `src/preload/index.ts`.

**Renderer:**
- `src/renderer/src/components/TaskPage.tsx` — render the segmented control (tasks header + composer dialog); wire to store; subscribe to the invalidation nonce.
- `src/renderer/src/components/github/IssueSourceSelector.tsx` — new segmented-control component.
- `src/renderer/src/store/slices/github.ts` — `setIssueSourcePreference` action, work-items cache eviction, `workItemsInvalidationNonce` counter.
- `src/renderer/src/store/slices/repos.ts` — add `issueSourcePreference` to the `updateRepo` Pick so the action can persist it.

### 9. Tests

- **Add `src/main/github/client-issue-source.test.ts`:** cover all three preference states × both remote-topology states (upstream exists / absent):
  - `preference='auto'` + upstream exists → upstream.
  - `preference='auto'` + no upstream → origin.
  - `preference='upstream'` + upstream exists → upstream.
  - `preference='upstream'` + no upstream → origin, `fellBack: true`.
  - `preference='origin'` + upstream exists → origin.
  - `preference='origin'` + no upstream → origin.
- **Persistence round-trip test** (new or extension of existing `src/main/persistence.test.ts`): set `issueSourcePreference`, reload Store, verify it survives. Set to `undefined`, verify it clears.
- **IPC test:** `repos:update` with `{ issueSourcePreference }` persists the field; reads come off the `Repo` record in `repos:list`. The persistence round-trip test above already covers the main invariant.
- **Renderer test:** clicking the segmented control triggers a cache invalidation and re-fetch of work-items for that repo.

### 10. Out of scope

- **Indicator and error surfacing** — sibling worktree (`feature-1-source-indicator-and-errors`). This worktree assumes the indicator will land separately. If it hasn't when this ships, the selector appears alone.
- **Base-ref pin seeding.** The parent doc considers seeding initial preference from `worktreeBaseRef` pins but defers it. Don't do it here.
- **Unified fork-preference setting.** If a later unified setting subsumes this one, migration is trivial — the new setting reads `issueSourcePreference` during transition. Not worth blocking on now.
- **Mid-session remote changes.** The `ownerRepoCache` staleness in `gh-utils.ts` remains a documented v1 limitation. The preference resolution is recomputed per call, but the underlying cache isn't invalidated on `git remote add/remove` mid-session. Acceptable.
- **PR-side source selection.** PRs continue to resolve off origin per the parent doc's out-of-scope list. See `/Users/thebr/orca/workspaces/orca/review-1076/docs/upstream-pr-visibility-investigation.md` for the open investigation.
- **Per-feature toggle sprawl concern.** One toggle is not a pattern. Parent doc §4 addresses this.

## Acceptance criteria

1. `Repo` has an optional `issueSourcePreference` field; persists across app restarts.
2. Segmented control `Upstream | Origin` renders in Tasks view header and Create Issue composer when upstream and origin resolve to different slugs. Hidden / disabled when they resolve to the same slug.
3. Active pill reflects the effective source (explicit preference if set, else heuristic-resolved). Clicking a pill writes the explicit preference.
4. `resolveIssueSource` honors all three states; preferred-upstream-with-no-upstream-remote case falls back to origin and emits `fellBack: true`.
5. One-time toast surfaces on fallback. Fires once per session per repo.
6. Cache invalidation on preference change triggers a re-fetch.
7. User B (fork contributor, auto) sees no behavior change — never touches the toggle, gets the upstream backlog as before.
8. User C (unrelated upstream) can flip to Origin once and never re-see upstream issues.
9. User D (fork contributor filing personal TODO) can flip the composer selector to Origin at the moment of filing.
10. `pnpm typecheck`, `pnpm lint`, and relevant vitest files pass:
    - `pnpm exec vitest run --config config/vitest.config.ts src/main/github/ src/main/persistence.test.ts src/renderer/src/store/`

## Commit shape

Suggested three commits:

1. `feat(shared): add issueSourcePreference to Repo type` — shared type + persistence Pick. Smallest possible landing zone for the new field.
2. `feat(github): resolveIssueSource helper and call-site migration` — new helper, migrate `issues.ts` and `client.ts` call sites, IPC plumbing.
3. `feat(ui): per-repo issue-source selector in Tasks view and composer` — segmented control UI, cache invalidation, toast on fallback.

Adjust granularity based on what comes out naturally — if IPC and UI end up small, fold them together.

## Coordination with sibling worktree

`feature-1-source-indicator-and-errors` touches the same Tasks-view header and composer surfaces. Land Feature 1 first if possible — the indicator work establishes the shared "sources" IPC envelope, which this worktree can then extend with the preference field rather than inventing its own. If Feature 2 has to go first, the selector renders standalone and the indicator is added in alongside the later merge.
