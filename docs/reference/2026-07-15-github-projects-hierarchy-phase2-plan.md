# GitHub Projects Hierarchy Phase 2 — Hierarchy-Aware Interactions

## Context

Phase 1b shipped flat, read-only hierarchy columns (`Parent issue`, `Sub-issues progress`, `Tracks`, `Tracked by`) in the existing table view. It does not let the user navigate the tree, see more than one level of roll-up, or add/remove/reorder sub-issues without leaving Orca. That's this phase, per RFC §8 Phase 2.

**Explicit non-goal (per RFC and user's "planifiquemos Phase 3 después"):** no tree/indented row rendering. This phase keeps the flat table as-is and adds hierarchy navigation + writes through the existing **work-item detail drawer** (`GitHubItemDialog.tsx`), which already exists and already has sections (comments, files, checks) — a "Sub-issues" section is additive to that surface, not a new view.

## Scope

1. **New read path**: Issue-level GraphQL query for `parent`, `subIssues` (up to 2 levels: direct children + each child's own `subIssuesSummary`), `subIssuesSummary`, `trackedIssues`/`trackedInIssues` — fetched on-demand when the drawer opens (lazy, not eager per-row), not baked into the Project table fetch.
2. **Client-side recursive aggregation utility** (pure function, `src/shared/`): given a hierarchy tree fetched to N levels, compute a whole-subtree completion percentage, since GitHub only aggregates one level.
3. **Write support via REST** (`project-view/mutations.ts` pattern): add sub-issue, remove sub-issue, reprioritize (reorder) sub-issue — respecting GitHub's hard limits (100 children/issue, 8 levels deep, one parent per issue) with client-side pre-validation before calling the API.
4. **Drawer UI**: a new "Sub-issues" section in `GitHubItemDialog.tsx` showing the parent (if any, clickable) and a list of direct sub-issues with checkboxes/progress, an "Add sub-issue" search-and-link affordance, and remove/reorder actions.
5. **Rate-limit integration**: reuse `rateLimitGuard('graphql')` / `rateLimitGuard('core')` and `noteRateLimitSpend`, matching the existing circuit-breaker pattern — no new rate-limit model.

## What this phase does NOT touch

- `ProjectRow.tsx` / `github-project-group-sort.ts` — table stays flat (Phase 3 concern).
- `FIELD_VALUES_SELECTION` / `itemContentSelection` in `project-view.ts` — Phase 1b's table-level fetch is untouched; Phase 2's hierarchy fetch is a separate, on-demand query scoped to the drawer, not the table's paginated item fetch (avoids adding GraphQL cost to every table row-load).
- Board/Roadmap layouts — still out of scope per RFC.

## Files

### New

- `src/main/github/project-view/hierarchy.ts` — read path (`getIssueHierarchy`) + write path (`addSubIssueBySlug`, `removeSubIssueBySlug`, `reprioritizeSubIssueBySlug`), following the `internals.ts`/`mutations.ts` split already established in this directory.
- `src/main/github/project-view/hierarchy.test.ts` — normalizer + validation tests (TDD: red before green, same as Phase 1b).
- `src/shared/github-issue-hierarchy-rollup.ts` — pure recursive aggregation function + its types.
- `src/shared/github-issue-hierarchy-rollup.test.ts`
- `src/renderer/src/components/github-item-dialog/SubIssuesSection.tsx` (or co-located wherever `GitHubItemDialog.tsx`'s existing sections live — to confirm exact path during implementation) + `.test.tsx`.

### Modified

- `src/shared/github-project-types.ts` — new `GitHubIssueHierarchyNode`/`GitHubIssueHierarchyResult` types, new args/result types for the 3 mutations, exported alongside the existing Phase 1b types.
- `src/main/ipc/github.ts` — 4 new `ipcMain.handle` registrations (`gh:getIssueHierarchy`, `gh:addSubIssue`, `gh:removeSubIssue`, `gh:reprioritizeSubIssue`).
- `src/preload/api-types.ts` — typed contract additions under `window.api.gh.*`.
- `GitHubItemDialog.tsx` — mount the new section, wire loading/error/optimistic-update state consistent with how comments/files are already handled there.

## Sequencing (TDD, mirrors Phase 1b's discipline)

1. Confirm exact GraphQL shape for `Issue.subIssues`/`subIssuesSummary` nested 2 levels via a live spike (the RFC flagged this as unconfirmed beyond `total`/`completed`/`percentCompleted`); confirm REST sub-issues endpoint request/response shapes live too.
2. Add shared types (hierarchy node, rollup, mutation args/results) — type-only commit.
3. Write failing tests for the rollup utility (`github-issue-hierarchy-rollup.test.ts`) — red.
4. Implement rollup utility — green.
5. Write failing tests for `getIssueHierarchy` normalizer (`hierarchy.test.ts`, hand-built raw fixtures, same pattern as `normalizeItem`) — red.
6. Implement `getIssueHierarchy` read path — green.
7. Write failing tests for the 3 REST mutations (success, 100-child-limit rejection, 8-level rejection, network/auth error classification) — red.
8. Implement the 3 mutations — green.
9. Wire IPC + preload contract.
10. Write failing component tests for `SubIssuesSection.tsx` (renders parent link, renders children list + progress, add/remove/reorder interactions) — red.
11. Implement `SubIssuesSection.tsx`, mount in `GitHubItemDialog.tsx` — green.
12. Full regression sweep (`src/main/github`, `src/renderer/.../github-project`, `src/renderer/.../GitHubItemDialog` or wherever it lives, `src/shared`) + typecheck (`tc:node`, `tc:cli`, `tc:web`).
13. Manual verification against `CodigoSinSiesta/1` real data (add/remove a real test sub-issue via the drawer, confirm the Phase 1b table's `Sub-issues progress` column updates on next table refresh — cross-phase consistency check) + screenshot evidence via the same CDP-to-own-dev-build approach used for Phase 1b (headless `browser` tool and `computer-use` both hit real walls last time — no auth session / accessibility permission denied respectively).
14. Update `docs/reference/2026-07-14-github-projects-hierarchy-traceability-design.md` RFC status for Phase 2, and file a follow-up issue/report in `CodigoSinSiesta/codigosinsiesta.github.io` mirroring issue #43's format.

## Open questions to resolve before/during the spike (step 1)

1. Exact `subIssues` nested-query shape and pagination behavior at 2 levels — RFC explicitly flagged this as unverified beyond the REST-mirrored guess.
2. Whether `addSubIssue`/`removeSubIssue`/`reprioritizeSubIssue` are exposed as GraphQL mutations (RFC's schema excerpt doesn't show them) or REST-only (RFC's confirmed REST table says REST is the practical mutation surface) — if REST-only, confirm exact request bodies for POST/DELETE/PATCH against `.../sub_issues` and `.../sub_issues/priority`.
3. Whether "Add sub-issue" needs a cross-repo issue search affordance (GitHub supports cross-repo and cross-org sub-issues since Sept 2025) or same-repo-only is an acceptable v1 scope — leaning same-repo-only for v1, cross-repo as a fast-follow, needs a quick confirm.

## Effort/risk (per RFC §11)

Medium-high effort, medium risk. Main risks: rate-limit spend on wide/deep trees (mitigated by lazy on-demand fetch + 2-level cap with "load more" instead of eager full-depth), and reproducing the GraphQL-vs-REST split correctly (mitigated by the step-1 spike before writing any fragment).
