# Phase 2 — Hierarchy-aware interactions in GitHub Projects

> Status: shipped and verified end-to-end against `CodigoSinSiesta/1` (real data, real Orca dev build, real GitHub mutations). One correction to the RFC's assumption surfaced during the spike — see below.

## Summary

Adds issue-level hierarchy navigation and writes to the work-item drawer's new **"Sub-issues" section** (`GitHubItemDialog.tsx`, issue pages only): shows the parent (if any), the direct sub-issues with a recursive roll-up progress summary, and lets the user **add**, **remove**, and **reorder** sub-issues without leaving Orca.

This is deliberately scoped to the drawer, not the table. Phase 1b's flat `Sub-issues progress` / `Parent issue` table columns (`ProjectCell.tsx`) are untouched — this phase adds navigation and writes on top of that read-only foundation. **Nested/indented table rows are explicitly out of scope** — that's Phase 3, gated on its own design review per the RFC.

## RFC correction found during the spike

The RFC (`docs/reference/2026-07-14-github-projects-hierarchy-traceability-design.md` §8, Phase 2) assumed writes would go through REST (`project-view/mutations.ts` pattern), since its schema excerpt of `Issue` didn't show mutation fields.

A live spike found otherwise: `addSubIssue`, `removeSubIssue`, and `reprioritizeSubIssue` **are GraphQL mutations**, confirmed via schema introspection and live execution against a disposable test issue:

```graphql
mutation { addSubIssue(input: { issueId: ID!, subIssueId: ID, subIssueUrl: String, replaceParent: Boolean }) { issue { ... } subIssue { ... } } }
mutation { removeSubIssue(input: { issueId: ID!, subIssueId: ID! }) { issue { ... } subIssue { ... } } }
mutation { reprioritizeSubIssue(input: { issueId: ID!, subIssueId: ID!, afterId: ID, beforeId: ID }) { ... } }
```

This is simpler than REST would have been: one round trip per mutation (plus a small ID-resolution query, since the mutations take GraphQL node IDs, not issue numbers), reusing the existing `runGraphql` plumbing instead of adding a second REST-based write path. The plan was updated in place rather than re-litigated — same redirect discipline as Phase 1b's field-value-union correction.

## What was built

### Files changed

```
 src/main/github/project-view.test.ts                             | +188 -1
 src/main/github/project-view.ts                                  | +97 -19
 src/main/github/project-view/internals.ts                        | +21 -0
 src/main/github/project-view/hierarchy.ts                        | new (read + write path)
 src/main/github/project-view/hierarchy.test.ts                   | new (22 tests)
 src/main/ipc/github.ts                                           | +29 -1
 src/main/runtime/orca-runtime.ts                                 | +38 -0
 src/main/runtime/rpc/methods/github.ts                           | +36 -0
 src/main/runtime/runtime-rpc.ts                                  | +4 -0
 src/preload/api-types.ts                                         | +15 -0
 src/preload/index.ts                                             | +22 -1
 src/renderer/src/components/GitHubItemDialog.tsx                 | +27 -0
 src/renderer/src/components/github-project/SubIssuesSection.tsx  | new
 src/renderer/src/components/github-project/SubIssuesSection.test.tsx | new (10 tests)
 src/renderer/src/web/web-preload-api.ts                          | +25 -1
 src/renderer/src/web/web-preload-api.test.ts                     | +34 -0
 src/shared/github-project-types.ts                                | +108 -0
 src/shared/github-issue-hierarchy-rollup.ts                       | new
 src/shared/github-issue-hierarchy-rollup.test.ts                  | new (7 tests)

 19 files changed/added, ~800 insertions
```

Also includes an unrelated-but-touched carryover from the Phase 1b session (`ColumnResizeHandle.tsx`, `ProjectCell.tsx`, `ProjectRow.tsx`, `ProjectViewList.tsx`, `column-widths.ts`, `github-project-group-sort.ts`) — already reported in issue #43; not re-described here.

### New read path — `getIssueHierarchy`

Single on-demand GraphQL query (fired when the drawer opens, not baked into the Project table's paginated fetch) requesting the parent, this issue's `subIssuesSummary`, and 2 levels of `subIssues` (direct children + each child's own direct children), bounded by `HIERARCHY_CHILDREN_PAGE_SIZE = 25` / `HIERARCHY_GRANDCHILDREN_PAGE_SIZE = 10` to stay well under GitHub's 10s GraphQL timeout risk on wide/deep trees. Returns `hasMoreChildren: boolean` when either level's page didn't cover its `totalCount`, for a future "load more" affordance.

### New pure aggregation utility — `computeHierarchyRollup`

`src/shared/github-issue-hierarchy-rollup.ts` — depth-agnostic recursive percentage calculator. GitHub's own `subIssuesSummary` only aggregates one level; this walks whatever depth was actually fetched and **trusts the node's own `subIssuesSummary` as the terminal count for any branch that wasn't expanded further** (so partial-depth trees still produce a correct total, not an undercount).

### New write path — 3 GraphQL mutations, same-repo v1 scope

`addSubIssueBySlug` / `removeSubIssueBySlug` / `reprioritizeSubIssueBySlug` in `project-view/hierarchy.ts`. Each validates args (self-reference rejection, slug shape, conflicting before/after) **before** touching the network, then resolves the parent/child/sibling issue numbers to GraphQL node IDs via a single dynamically-aliased query (`buildResolveIssueIdsQuery`), then executes the mutation.

Cross-repo sub-issues (GitHub supports this since Sept 2025) are **not** in v1 scope — the args are same-repo only; documented as a fast-follow, not silently dropped.

### SSH/remote-runtime wiring (AGENTS.md's SSH Use Case rule)

All 4 new methods (`getIssueHierarchy`, `addSubIssue`, `removeSubIssue`, `reprioritizeSubIssue`) are wired through the full existing remote-dispatch stack, not just the local Electron IPC path:

- `orca-runtime.ts` — 4 thin proxy methods (`getGitHubProjectIssueHierarchy`, etc.), same shape as the 15+ existing BySlug proxies.
- `runtime/rpc/methods/github.ts` — 4 new `defineMethod` entries with Zod param schemas.
- `runtime-rpc.ts` — allow-listed under `github.project.*`.
- `web-preload-api.ts` — routed for the browser/paired-web client (`GITHUB_WEB_RPC_METHODS`), with matching parity + routing tests.
- `SubIssuesSection.tsx` — dispatches via `getActiveRuntimeTarget`/`callRuntimeRpc` when a remote environment is active, falling back to local `window.api.gh.*`, mirroring `SlugDialogBody.tsx`'s established pattern.

### UI — `SubIssuesSection.tsx`

Mounted in `GitHubItemDialog.tsx`, issue pages only (`isIssuePage` branch), right after the existing `GHEditSection` metadata block. Renders:
- Parent row (clickable link to the parent issue), when present.
- Roll-up progress bar + `completed/total` text, when there are sub-issues.
- Each direct sub-issue as a clickable link + title, with (when editable) move-up / move-down / remove buttons.
- An "Issue number" input + "Add sub-issue" button, when editable.
- Renders nothing (`<></>`) when there's no parent, no sub-issues, and the drawer isn't editable — avoids cluttering every issue's drawer with an empty section.

## Evidence

### 1. Live GraphQL mutation spike (2026-07-15, before writing any code)

Created a disposable issue, ran all 3 mutations against it live, confirmed each one's effect via a follow-up query, then reverted and closed the issue:

```
addSubIssue(#42, #44)        → #42.subIssuesSummary.total: 0 → 1 ✓, #44.parent.number: 37 ✓
removeSubIssue(#42, #44)     → #42.subIssuesSummary.total: 1 → 0 ✓, #44.parent: null ✓
reprioritizeSubIssue(#37, #44, beforeId: #38) → subIssues order: [44, 38, 39, 42] ✓ (was [38,39,42,44])
```

### 2. Unit test results (all real runs, this session)

| Suite | Result |
|---|---|
| `src/shared/github-issue-hierarchy-rollup.test.ts` | 7 passed (new file) |
| `src/main/github/project-view/hierarchy.test.ts` | 22 passed (new file — normalizer + validation, no `gh` mocking needed) |
| `src/renderer/.../SubIssuesSection.test.tsx` | 10 passed (new file) |
| `src/main/runtime/rpc/methods/github.test.ts` + `runtime-rpc.test.ts` + `web-preload-api.test.ts` | 133 passed (SSH/remote-runtime wiring, including 4 new parity/routing rows) |
| Full sweep: `src/main/github` + `src/main/runtime` + `src/shared` + `src/renderer/.../web` + `src/renderer/.../github-project` + `GitHubItemDialog.tsx` + `src/renderer/.../store` | **6643 passed, 8 skipped, 0 failed** (484 files) |
| `pnpm tc:node` / `tc:cli` | clean |
| `pnpm tc:web` | clean except the same pre-existing, unrelated Monaco editor type mismatch reported in issue #43 |

### 3. Live UI verification — real Orca app, real writes, real revert

Connected via CDP to a freshly-launched Orca dev build (same method as issue #43 — no auth wall since it's the agent's own process, distinct from the headless `browser` tool / `computer-use`, both of which hit real environment limits last time). Opened the drawer for issue `#37` in `CodigoSinSiesta/1`.

**Before** (Phase 1b only — Phase 2's mount point temporarily removed via `git stash push -- GitHubItemDialog.tsx`, confirmed via HMR reload, then restored via `git stash pop`):

![Before: no Sub-issues section, metadata goes straight to Activity/comments](https://raw.githubusercontent.com/CodigoSinSiesta/codigosinsiesta.github.io/main/docs/phase-2-evidence/before-no-sub-issues-section.png)

**After** (Phase 2, stable state — `#37`'s real sub-issues `#38`/`#39`/`#42`, roll-up `0/5` — 3 direct children + 2 grandchildren via `#38`→`#40` and `#39`→`#41`, matching `computeHierarchyRollup`'s expected math exactly):

![After: Sub-issues section with progress bar, 3 real children, add-sub-issue input](https://raw.githubusercontent.com/CodigoSinSiesta/codigosinsiesta.github.io/main/docs/phase-2-evidence/after-sub-issues-section.png)

**Live write-path proof** — created disposable issue `#45`, typed `45` into the section's input, clicked "Add sub-issue": roll-up updated `0/5` → `0/6` and `#45` appeared in the list, in the real running UI:

![Live add: #45 appears, roll-up updates to 0/6](https://raw.githubusercontent.com/CodigoSinSiesta/codigosinsiesta.github.io/main/docs/phase-2-evidence/live-add-sub-issue-45.png)

Verified against the live GitHub API (not just the UI) before and after each step:
```
after add:    #37.subIssuesSummary.total: 3 → 4 ✓, #45.parent.number: 37 ✓
after remove: #37.subIssuesSummary.total: 4 → 3 ✓, #45.parent: null ✓
```
Then clicked the section's "Remove #45" button (confirmed via UI observation the row disappeared and reappeared correctly after the async refetch), and closed the disposable issue.

## Known limitations

- **Same-repo sub-issues only in v1.** GitHub supports cross-repo/cross-org sub-issues (since Sept 2025); the write-path args don't carry a second owner/repo yet. Documented fast-follow, not a silent gap.
- **Depth-limit (8 levels) is not pre-validated client-side.** Only the children-count/self-reference guards are cheap enough to check without an extra read; a depth violation is relayed via GitHub's own error message through the existing `classifyProjectError` path rather than pre-checked. Documented in `hierarchy.ts`'s validation section comment.
- **2-level fetch cap.** `getIssueHierarchy` fetches the issue's direct children and each child's own direct children, not further. `hasMoreChildren` signals when either level's page didn't cover its full count; a "load more" UI affordance for deeper/wider trees is not built in this pass.
- **No nested/indented rows** — this phase is entirely additive to the drawer; the Project table stays flat, per the RFC's Phase 2/Phase 3 split and the user's explicit "planifiquemos Phase 3 después" direction.

## References

- RFC: `docs/reference/2026-07-14-github-projects-hierarchy-traceability-design.md` (Phase 2 section updated with a shipped-status note and the REST→GraphQL correction)
- Plan: `docs/reference/2026-07-15-github-projects-hierarchy-phase2-plan.md`
- Phase 1b report (prior phase, same RFC): issue #43
