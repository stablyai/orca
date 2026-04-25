# Engineering Spec: "Start from" field in Create Workspace

## Summary

Add a **"Start from"** field to the Create Workspace composer that lets the user pick a **branch or PR** as the basis for the new workspace. The picker is scoped to the selected repo; changing repo resets the field. This replaces no existing behavior: "Start from" defaults to the repo's **effective base ref** (`repo.worktreeBaseRef` when configured, otherwise the repo's detected default branch), so the current quick-create flow is unchanged.

This spec targets the shared composer flow, not just the modal wrapper. The quick-create modal and the full-page composer both consume `NewWorkspaceComposerCard` + `useComposerState`, so the new field/state should live there unless a piece is truly modal-only.

**Issues are out of scope for this picker.** Picking an issue does not change the base ref — it only sets `linkedIssue`, which the existing Link-work-item UI (`useComposerState.ts:256–260`) already handles. Putting Issues in a picker called "Start from" creates a second entry point into the same state and misleads the user. Users who want to link an issue use the existing Link UI.

## User-visible behavior

| Selection | Branch created from | Workspace metadata |
|---|---|---|
| Branch (default or other) | selected branch/ref | — |
| PR | PR's same-repo head branch/ref | `linkedPR = #N` |

Important: Orca's create flow always creates a new worktree branch derived from the workspace name. "Start from PR" therefore means **branch from the PR head**, not "check out the PR branch directly".

**Scope for v1:** local repos support both picker tabs. Remote SSH repos support **Branches** only in this spec; PR start points stay disabled there until GitHub lookup can run without assuming a local `cwd`.

**PR scope for v1:** only PRs whose head branch lives in the selected repo are selectable. Fork PRs render disabled with copy like *"Fork PRs aren't supported yet in Start from"* because the current create flow cannot safely resolve a fork head from `headRefName` alone.

**Repo ↔ Start from contradiction:** the picker is repo-scoped. Changing `repoId` clears the prior selection and resets the field to the new repo's effective base ref. The field renders the reset inline (e.g. trigger reads *"Default branch — was PR #8778"*) instead of a fading toast, so the state is recoverable visually and not missed by users focused on another field.

**Naming:** when the picker selects a PR and the Name field is still auto-managed (matches `lastAutoNameRef.current`, including empty), apply the existing auto-name behavior from `getLinkedWorkItemSuggestedName()` to the actual `name` state. Once the user edits the name, subsequent PR selections leave `name` alone. This matches the existing Link-UI rule exactly — one code path, not two.

**Linked-work-item interaction:** the picker writes into the *same* `linkedWorkItem`/`linkedPR` state that the Link UI owns. A PR selection is a `linkedWorkItem` assignment. Switching back to a branch leaves `linkedWorkItem` alone: the user changed the *start ref*, not the *link*. If the user wants to remove the link, they use the Link UI. No source-tagging, no parallel state, no "whose selection was it" bookkeeping.

---

## Data model

**No new shared type.** The "Start from" picker is a UI affordance that writes into fields the system already has:

- `CreateWorktreeArgs.baseBranch` (existing, `src/shared/types.ts:461`) — carries the resolved git ref the new worktree branches from.
- `WorktreeMeta.linkedPR` (existing, `src/shared/types.ts:56`) — set on PR selection. `useComposerState` already owns `linkedWorkItem` + `linkedPR` state and already writes it via `applyWorktreeMeta` post-create (`useComposerState.ts:880`).

Every picker selection reduces to one of:

| Picker selection | `baseBranch` passed to create | Linked metadata |
|---|---|---|
| Branch, local row | short branch name (e.g. `main`) | — |
| Branch, remote-tracking row | remote-qualified form from the row's full refname (e.g. `origin/main`, `upstream/feat-x`) | — |
| PR #N (same-repo head) | `<remote>/<headRefName>` after main-process `git fetch` of that ref (see PR head resolution) | `linkedPR = N` |

Why full-ref precision without a new type: local and remote-tracking refs are not interchangeable. The picker emits the right short form to `baseBranch` — remote-tracking rows pass the `<remote>/<name>` form so the new branch tracks the remote ref instead of creating a detached HEAD. Classification at the picker must use the row's underlying full refname (`refs/heads/…` vs `refs/remotes/<remote>/…`), never prefix-matching a short name (a local branch literally named `origin/foo` is legal). The remote name comes from the row's full refname, not a hardcoded `origin` — repos can have `upstream` or other remotes.

**Scope note on main-side remote derivation.** `createRemoteWorktree` (`worktree-remote.ts:96`) and `createLocalWorktree` (`worktree-remote.ts:243`) currently derive the remote as `baseBranch.includes('/') ? baseBranch.split('/')[0] : 'origin'`. For picker selections this is fine — remote-tracking rows and PR refs always contain a slash, so the derived remote is correct. Branch-picker rows without a slash are local heads, and the `'origin'` fallback is unused. Non-picker code paths that pass slashless remote refs still hit the `origin` hardcode; fixing that is *out of scope* for this spec. The `resolvePrBase` resolver (below) must derive the push remote explicitly, since the PR head may live on `upstream` or another remote configured at the repo level.

**PR head resolution lives in main, not the renderer.** `gh pr list` returns `headRefName` as a short branch name that typically does not exist locally. Passing the bare `headRefName` as `baseBranch` will fail `git worktree add` in the common case. Git-ref resolution (`git fetch`, `git rev-parse`) belongs in main; the renderer does not shell out.

New IPC: `worktrees:resolvePrBase`
```ts
window.api.worktrees.resolvePrBase({
  repoId,
  prNumber,
  // Optional cache hints from the renderer's existing PR cache.
  // When both are present, main skips the `gh pr view` lookup.
  headRefName?: string,
  isCrossRepository?: boolean,
}) => Promise<{ baseBranch: string } | { error: string }>
```
On PR selection, the picker calls this resolver. Main:
1. If both hints are present, skip GitHub lookup. Otherwise resolve the PR via the existing GitHub client to obtain `headRefName` + `isCrossRepository`.
2. Reject fork PRs (`isCrossRepository === true`) with `"Fork PRs aren't supported yet"`.
3. Runs `git fetch <remote> <headRefName>` against the repo's default remote (see Default remote selection below).
4. Verifies the fetched ref with `git rev-parse --verify <remote>/<headRefName>`.
5. Returns `{ baseBranch: "<remote>/<headRefName>" }` or a user-readable error.

Pre-submit resolution surfaces "branch deleted on remote" in the picker, not at create time. The resolved string is the one passed to `CreateWorktreeArgs.baseBranch` — no special `kind: 'pr'` at the IPC boundary.

**Concurrency / stale resolves.** A PR selection commits to `baseBranch` only after `resolvePrBase` succeeds. If the user selects a second PR before the first resolves, the first resolve's result is discarded (last-click-wins). Track this in the picker with a per-click token or `AbortController`; do not simply `await` sequentially, or late resolves will clobber newer selections.

**Submit while resolve pending.** If the user triggers create while a `resolvePrBase` is still in flight, the submit path waits for the pending resolve (or fails fast with a visible "Resolving PR head…" state). It must not submit with an unresolved `baseBranch` and it must not submit with the *previous* selection's `baseBranch`.

**Default remote selection.** "Default remote" is not "the one named `origin`." Resolve inside `resolvePrBase` in this order: (1) the remote configured on the repo's default branch (`git config branch.<default>.remote`); (2) `origin` if present; (3) the single remote if the repo has exactly one; (4) error otherwise (ask the user to configure). Centralize this in a helper in `src/main/git/repo.ts` rather than re-deriving per call site.

**WSL repos.** The existing main-process helpers route through `isWslPath` / `parseWslPath` (`src/main/ipc/worktree-remote.ts:19`). `worktrees:resolvePrBase` must use the same routing for its `git fetch` / `rev-parse` calls, not bare `gitExecFileAsync` on a raw path, or WSL repos will fail to resolve.

**Draft restore.** `newWorkspaceDraft.baseBranch` is persisted. On composer mount a restored `baseBranch` may reference a ref that no longer exists (PR closed, branch deleted since yesterday). Current main-process behavior will silently fall back to `worktreeBaseRef` / default branch rather than erroring — this is the same v1 hole tracked in Follow-up chores. Optional v1 nicety: run a cheap `rev-parse --verify` on mount (local repos only); if the ref is gone, clear `baseBranch` in the draft and show a one-line hint in the field ("Previous start ref no longer exists"). Don't block the user.

**Accessibility.** The popover must support keyboard-only operation: arrow keys within a tab, Tab / Shift+Tab between tabs, Enter to commit, Esc to close without committing. Reuse the existing Link-UI popover's keyboard hook rather than re-implementing.

### `GitHubWorkItem` additions (`src/shared/types.ts:390`)

One new field is needed. `GitHubWorkItem` already carries `branchName?: string` (`src/shared/types.ts:400`), which `src/main/github/client.ts:636` populates from `headRefName` for PR rows. **Reuse `branchName` — do not introduce a second field meaning "PR head branch".** Throughout this spec, reads of "the PR's head branch" on `GitHubWorkItem` refer to `branchName`.

```ts
isCrossRepository?: boolean // true = fork PR; disabled in picker
```

**Verification:** `gh pr list` in `src/main/github/client.ts:280,401,610` currently requests `number,title,state,url,labels,updatedAt,author,isDraft,headRefName,baseRefName`. Add `headRepositoryOwner` to the field list at all three sites; compute `isCrossRepository` in the mapper as `item.headRepositoryOwner?.login !== <selected repo owner>`. Mapper change lands at `src/main/github/client.ts:636`, where `branchName` is already set — this is the one place fork detection is computed.

### Draft persistence (`src/renderer/src/store/slices/ui.ts:64`)

Extend `newWorkspaceDraft` with `baseBranch?: string`. Absence means "use the repo's effective base ref" — no `null`-plus-conversion step, shape matches `CreateWorktreeArgs.baseBranch`. `linkedPR` / `linkedWorkItem` are already persisted, so PR selections round-trip without further schema changes.

No new `worktrees:create` wire change. The existing contract already carries `baseBranch`.

---

## Main-process changes

### IPC handlers

- `src/main/ipc/worktrees.ts` — wire the new `worktrees:resolvePrBase` handler (signature + algorithm defined in §Data model). Handler module may live adjacent if it grows.
- `src/main/ipc/worktree-remote.ts` — **no changes**. The existing `||` fallback chain is preserved as-is. The picker emits validated refs (branch rows from `searchBaseRefs` exist; PR refs are `git fetch`ed + `rev-parse`d inside `resolvePrBase` before the picker commits them to `baseBranch`), so in practice the picker never hands an unresolvable ref to create.

### Base-ref resolution

No main-process branching on "kind". The renderer collapses every picker selection into a `baseBranch` string (and, for PR selections, `linkedPR` metadata). The existing `args.baseBranch || repo.worktreeBaseRef || <detected default>` chain in `createLocalWorktree` / `createRemoteWorktree` is unchanged.

Known limitation (acceptable for v1): if a picker-selected ref is deleted between selection and submit, create silently falls back instead of erroring. In practice this requires the remote branch to disappear in the seconds between picker commit and Create click — vanishingly rare. Tightening this into strict-when-explicit behavior is tracked as a follow-up chore (see `Follow-up chores`).

### Metadata persistence

PR selections set `linkedPR` in the existing composer state. The existing post-create `applyWorktreeMeta` call (`useComposerState.ts:880`) already writes it — no new write path.

If metadata persistence fails after the git worktree already exists, log and continue. The worktree is still valid even if the link badge is missing.

### GitHub data scope

- local repos, PRs: existing `gh:listWorkItems` (cached — see caching rules below)
- local repos, direct number lookup: existing `gh:workItem` (cached)
- branches: existing `repos:searchBaseRefs`

No new GitHub IPC is required for local repos in v1.

### Create-time validation

Unchanged. The picker pre-validates refs (branches via `searchBaseRefs` results, PR heads via `resolvePrBase`'s fetch + `rev-parse`), so most bad paths are caught before submit. The one remaining hole — ref deleted between commit and create — falls through to today's silent fallback; see `Follow-up chores`.

---

## Caching rules (must read)

PR searches and number lookups hit the user's `gh` CLI quota. The picker **must** ride on the existing SWR caches in `src/renderer/src/store/slices/github.ts`; it must not introduce a parallel fetch path.

**Required behavior:**

- **Always call `fetchWorkItems(repoPath, limit, query, options?)`** — never `window.api.gh.listWorkItems(...)` directly. The store already deduplicates in-flight requests (`inflightWorkItemsRequests`) and applies `WORK_ITEMS_CACHE_TTL`. Direct calls bypass both.
- **Use the prefetch path to warm shared keys.** The cache key is `(repoPath, limit, query)`. The picker's query **must** match the prefetch query exactly or cache hits won't share. Use:
  - Prefetch on composer mount (local repo): `prefetchWorkItems(repoPath, 36, 'is:pr is:open')`.
  - Picker PR tab default list: `fetchWorkItems(repoPath, 36, 'is:pr is:open')`.
  - Picker PR tab user query: `fetchWorkItems(repoPath, 36, \`is:pr is:open \${userQuery}\`)` — queries debounced ~150ms (matches existing Link-UI debounce) so rapid typing collapses to one fetch.
- **Render cached results synchronously while revalidating.** Use `getCachedWorkItems(...)` for the first paint so opening the popover is instant and costs zero API calls when the cache is fresh.
- **Direct-number lookup (`#123`, full URL) uses `gh:workItem` via its cache.** Same SWR contract; the picker reads `prCache`/`issueCache` synchronously first.
- **Do not prefetch on every keystroke.** Only prefetch (a) on composer mount and (b) on popover open. Search queries go through the debounced `fetchWorkItems`, which dedupes against the cache anyway.
- **PR resolver (`worktrees:resolvePrBase`) must reuse the renderer-side PR cache when available.** The renderer passes the already-known `headRefName` and `isCrossRepository` to the resolver (as an optional hint); main skips the `gh pr view` call when the hint is present. Only the `git fetch` + `git rev-parse` steps always run, since remote refs can change.
- **Branch search (`repos:searchBaseRefs`) is git-local and cheap**; it does not count against GitHub quota, so fetch-on-demand when the Branches tab becomes active is acceptable. Debounce ~150ms to avoid redundant `git for-each-ref` invocations on large repos.

**Do not** call `prefetchWorkItems(repoPath, 'is:open')` — the second argument is `limit`, not `query`, and this would silently prefetch a different cache key than the picker reads.

**Audit existing prefetch callers.** `ui.ts:195` already calls `prefetchWorkItems(repo.path, 36, presetToQuery(preset))`. Confirm during implementation that at least one active task preset produces `'is:pr is:open'` (the exact string the picker queries) so the sidebar prefetch and the picker fetch share a cache key. If no preset matches exactly, add a dedicated mount-time prefetch in the composer and do not rely on the sidebar's opportunistic warming.

**Cache invalidation.** The existing SWR caches are keyed by `(repoPath, limit, query)` and expire via `WORK_ITEMS_CACHE_TTL`. The picker does **not** call `force: true` on every open — that defeats the cache. It only forces a refresh on explicit user action (e.g. a "Refresh" control in the popover, if added later). Stale-within-TTL is acceptable for picker use.

---

## Renderer changes

### 1. New components

- `src/renderer/src/components/new-workspace/StartFromField.tsx`
  - popover trigger (pill + title + chevron)
- `src/renderer/src/components/new-workspace/StartFromPicker.tsx`
  - tabs: **Branches · Pull requests**
  - search input debounced ~150ms
  - PR tab calls `worktrees:resolvePrBase` on selection; shows an inline error on fetch/resolve failure *before* the user submits
  - on selection, calls back into `useComposerState` with `{ baseBranch, linkedWorkItem? }` — no new shared type

### 2. Popover state coverage

Each tab must render these states explicitly:

| Flow | Loading | Empty | Error | Success |
|---|---|---|---|---|
| Branches | skeleton rows | "No branches match" | inline error | list |
| Pull requests | skeleton rows (only if no cached data) | "No open PRs" | "gh not available — Branches tab still works" | list (cached first, revalidated in background) |

Cached results must paint immediately; the loading state appears only when nothing is cached. This makes the common case a zero-API-cost open.

### 3. Integrate into shared composer state

Add `baseBranch?: string` state in `src/renderer/src/hooks/useComposerState.ts` (reusing the existing `linkedWorkItem` / `linkedPR` state for PR selections — don't introduce parallel `startFrom` state). The hook already owns:

- repo selection
- `linkedWorkItem` + `linkedPR` (see `useComposerState.ts:209,223`)
- auto-name behavior via `lastAutoNameRef` (`useComposerState.ts:262`)
- full-page draft persistence
- submit / submitQuick, with post-create `applyWorktreeMeta` already writing linked metadata (`useComposerState.ts:880`)

The modal wrapper should stay thin. `NewWorkspaceComposerModal.tsx` continues to pass through `cardProps` to `NewWorkspaceComposerCard`, while the card gets new props for rendering the field.

### 4. Picker data sources

- Branches tab:
  - `window.api.repos.searchBaseRefs({ repoId, query })`
- PRs tab:
  - `fetchWorkItems(repoPath, 36, 'is:pr is:open')` for the default list
  - `fetchWorkItems(repoPath, 36, \`is:pr is:open \${userQuery}\`)` for typed queries
  - `getCachedWorkItems(...)` for first paint

Use the selected repo object already derived in `useComposerState`; do not introduce a separate `reposById` dependency unless the store actually gains one.

Filter PR results to same-repo heads only (`!isCrossRepository`). Fork PRs render disabled with explanatory copy, not silently filtered, so the user understands why their PR isn't selectable.

Normalize PR queries before dispatching GitHub lookups. Route by shape:

- bare number (`123`), `#123`, or a full GitHub PR URL for the selected repo → strip to the number and dispatch `gh:workItem` (reads `prCache` first per §Caching rules). `getWorkItem` returns `type: 'pr' | 'issue'`; when `type !== 'pr'`, treat as no-match in the PR tab (number collides with an issue).
- full GitHub PR URL for a *different* repo → silently fall back to free-text search. Do not hard-block; users paste URLs because they want the content.
- anything else → pass through as a free-text query to `fetchWorkItems(..., \`is:pr is:open \${query}\`)`.

### 5. Repo-change reset

On repo change:

- reset `baseBranch` to `undefined` (so the field shows the new repo's effective base ref as placeholder)
- clear any transient picker state tied to the previous repo
- the field's trigger copy shows the reset inline (e.g. *"Default branch — was PR #N"*) when a selection was cleared

The existing `handleRepoChange` callback (`useComposerState.ts:819`) already clears `linkedIssue` / `linkedPR` / `linkedWorkItem` inline; extend it to also clear `baseBranch`. One callback, not a new effect.

### 6. Naming behavior

When the picker selects a PR, it sets the existing `linkedWorkItem` state. The composer's existing auto-name path (which reacts to `linkedWorkItem` via `getLinkedWorkItemSuggestedName` and `lastAutoNameRef`) will update `name` iff `name === '' || name === lastAutoNameRef.current` — i.e. the name is still auto-managed. Once the user edits the name, subsequent selections leave it alone. This is the existing Link-UI rule; no new naming code.

### 7. Submission

Thread `baseBranch` through:

- `useComposerState` submit paths (already constructs `CreateWorktreeArgs` — just add the field)
- persisted `newWorkspaceDraft`
- store `createWorktree(...)` → preload `window.api.worktrees.create(...)` → main `CreateWorktreeArgs` (field already exists)

`linkedPR` needs no new wiring — the post-create `applyWorktreeMeta` call already writes it.

### 8. Prefetch

On composer mount (local repo only), warm the PR cache:

```ts
prefetchWorkItems(repoPath, 36, 'is:pr is:open')
```

Do **not** call `prefetchWorkItems(repoPath, 'is:open')`; the second argument is `limit`, not `query`. Do **not** use a query string that differs from what the picker will fetch — mismatched keys produce a double fetch.

Branch results stay fetch-on-demand when the Branches tab becomes active.

---

## Shortcut discoverability

Out of scope for this spec. A follow-up can add a split "+" button with `CmdOrCtrl+Shift+N` for a more explicit "Create from…" entry point.

## Explicitly out of scope

- **Issues tab.** Issues do not change the start ref; use the existing Link UI to link an issue.
- **Checking out an existing branch without `-b`.** Orca's create flow always derives a new branch from the workspace name; "Start from PR" means branch from the PR head, not open the PR branch directly.
- **Fork PR start points.** Disabled in v1.
- **SSH PR start points.** Disabled in v1.

---

## Edge cases

| Case | Behavior |
|---|---|
| User picks PR, then renames Name manually | Manual name wins (existing `lastAutoNameRef` rule) |
| User picks PR, then picks a different PR without editing name | Name updates to the new PR's suggestion |
| User picks PR from a fork | picker disables it in v1; no create attempt |
| PR head branch has since been deleted at picker open | picker surfaces resolve error before submit; create never attempted |
| PR head fetch fails (network/auth) | picker surfaces the fetch error; selection does not commit |
| User picks branch, switches repo, switches back | no cross-repo picker state is preserved |
| Offline / `gh` CLI missing | PRs tab shows error state; Branches tab still works |
| Remote repo over SSH | only Branches tab is enabled in v1; PRs tab disabled with explanatory copy |
| Repo has `worktreeBaseRef` set to non-default branch | reset behavior uses that configured base ref |
| User pastes `#123` or a full GitHub PR URL | picker normalizes to the work item number and uses `gh:workItem` cache |
| Pasted number resolves to an issue, not a PR, in the PR tab | treated as no-match; user sees empty-state copy |
| User pastes a PR URL for a different repo | picker silently falls back to free-text search |
| Selected ref (branch or PR head) disappears between picker commit and create | falls through to today's `worktreeBaseRef` / default-branch fallback (acceptable v1 hole; tracked in Follow-up chores) |
| Restored draft references a ref that no longer exists | same silent fallback at create; optional v1 nicety clears the draft field with an inline hint on mount |
| Popover opened with fresh cache | renders instantly from `getCachedWorkItems`; zero API calls |
| User selects PR, then quickly selects a different PR before first resolve returns | last-click wins; stale resolve is discarded (AbortController / token) |
| User hits Create while `resolvePrBase` is still pending | submit waits for the in-flight resolve; never submits with a stale `baseBranch` |
| User rapidly toggles between Branches and PRs tabs mid-fetch | in-flight search requests for the prior tab are aborted; stale rows never render |

---

## Test plan

- **Unit / renderer**
  - `StartFromField` renders the correct pill for each selection kind
  - repo change resets `baseBranch` and the field shows the reset inline
  - full-page draft persistence round-trips `baseBranch` (and existing linked-work-item fields)
  - PR selection updates the actual `name` state only while it remains auto-managed (`name === '' || name === lastAutoNameRef.current`)
  - PR selection mirrors into linked-work-item state; switching back to branch does **not** clear the link
  - SSH repos disable PR tab
  - cross-repo PRs are disabled with explanatory copy
  - `#123` and full GitHub PR URLs normalize to number search
  - pasted cross-repo URLs fall back to free-text search (no hard error)
  - picker writes short name for local branch rows, `<remote>/<name>` for remote-tracking rows
  - PR selection calls `worktrees:resolvePrBase` and threads the resolved ref into `baseBranch`
- **Caching**
  - opening the PR tab with a fresh cache triggers **zero** `window.api.gh.listWorkItems` calls (assert via spy)
  - prefetch on composer mount and picker default fetch share the same cache key (`(repoPath, 36, 'is:pr is:open')`)
  - rapid typing in the PR search debounces to a single fetch
  - direct-number lookup (`#123`) reads `prCache`/`issueCache` synchronously before hitting `gh:workItem`
  - `worktrees:resolvePrBase` skips `gh pr view` when the renderer passes a cached `headRefName` hint
  - rapid re-selection aborts prior `resolvePrBase`; only the latest selection's result commits
  - submit while `resolvePrBase` is pending waits for it; never submits a stale `baseBranch`
- **Main-process**
  - `worktrees:resolvePrBase` fetches via the repo's default remote (not hardcoded `origin`), returns resolved ref on success
  - `worktrees:resolvePrBase` returns a user-readable error when the remote branch is missing or fetch fails
  - `worktrees:resolvePrBase` rejects fork PRs
  - `isCrossRepository` is populated on `GitHubWorkItem` PR rows from `headRepositoryOwner`
- **Manual**
  - quick create without touching the field behaves exactly as today
  - create from same-repo PR creates a new branch from the PR head and shows the PR badge
  - SSH repo shows branch start points only
  - changing repo mid-flow resets the field and shows the inline reset copy
  - opening the picker a second time within the cache TTL makes zero network calls

---

## Rollout

Single PR. No feature flag. The change is additive and backward-compatible — `baseBranch` is already optional on `CreateWorktreeArgs`, and `linkedPR` metadata is already written by existing code.

## Files touched

```text
src/shared/types.ts                                                  (add isCrossRepository to GitHubWorkItem; branchName already carries PR head)
src/main/github/client.ts                                            (add headRepositoryOwner to gh pr list field set; populate isCrossRepository)
src/main/ipc/worktrees.ts                                            (new worktrees:resolvePrBase handler)
src/main/git/repo.ts                                                 (default-remote helper used by resolvePrBase)
src/preload/index.ts                                                 (invoke worktrees:resolvePrBase)
src/preload/api-types.d.ts                                           (type worktrees.resolvePrBase)
src/renderer/src/hooks/useComposerState.ts                           (baseBranch state + repo-change reset)
src/renderer/src/components/NewWorkspaceComposerCard.tsx             (render the field)
src/renderer/src/components/new-workspace/StartFromField.tsx         (new: pill trigger)
src/renderer/src/components/new-workspace/StartFromPicker.tsx        (new: tabs + picker; SWR via fetchWorkItems/getCachedWorkItems)
src/renderer/src/store/slices/ui.ts                                  (baseBranch in newWorkspaceDraft)
src/renderer/src/lib/new-workspace.ts                                (if a small display helper is needed)
```

Estimated effort: ~1.5 engineering days — new `worktrees:resolvePrBase` IPC, `isCrossRepository` plumbing through the `gh` client and its mappers, picker + cancellation, URL normalization, prefetch key alignment, and renderer + main tests. Fully additive; no behavior change for existing flows.

## Follow-up chores

File these as separate issues at ship time, not in this PR:

- **Strict-when-explicit base-ref validation.** Today `createLocalWorktree` / `createRemoteWorktree` silently fall back when an explicit `args.baseBranch` is unresolvable. The Start-from picker avoids this in practice by pre-validating, but a ref deleted between selection and submit still falls through. Replace the `||` chain with strict-when-explicit / fallback-when-implicit; add `SshGitProvider.verifyRef` for the remote path. Standalone refactor, own test coverage, affects all callers of `CreateWorktreeArgs.baseBranch`.
- **Main-side default-remote derivation.** `createLocalWorktree` / `createRemoteWorktree` derive remote as `origin` when `baseBranch` lacks a slash. Centralize default-remote resolution (push remote of default branch → `origin` → single remote) and share with `resolvePrBase`.
