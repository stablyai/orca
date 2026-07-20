# Phase 1b — Hierarchy traceability in GitHub Projects (flat columns only — NOT tree/nested rows)

> Status: Phase 1 of the RFC is shipped and verified end-to-end against `CodigoSinSiesta/1` (real data, real Orca dev build). Two real bugs were found and fixed during verification — see below.
>
> **Scope correction (2026-07-15):** this delivers `Parent issue` / `Sub-issues progress` / `Tracks` / `Tracked by` as **flat, read-only table columns** — a count (`0/3`) and a link to the parent, on the *same row* as every other item. It does **not** render sub-issues as indented/nested child rows under their parent (no tree, no expand/collapse). That capability is explicitly **Phase 3** in the RFC (`docs/reference/2026-07-14-github-projects-hierarchy-traceability-design.md` §8), gated behind its own design review, and is **not started**. If your acceptance bar for "hierarchy support" includes visual nesting, this issue is not yet complete for that bar — treat it as Phase 1 done, Phase 3 (nested rows) still to be scoped.

## Summary

Makes `Parent issue`, `Sub-issues progress`, `Tracks`, and `Tracked by` render from GitHub's authoritative data in Orca's Project table view. This data lives on the linked `Issue` object (`Issue.parent`, `Issue.subIssuesSummary`, `Issue.trackedIssues`, `Issue.trackedInIssues`) — not on the ProjectV2 field-value union, which has no corresponding members as of 2026-07-14 (confirmed via live `__type` introspection: 12 union members, none hierarchy-related).

`PARENT_ISSUE` is now a clickable link to the parent issue (was plain `#<number>` text before). **Rows are still flat** — a child issue with a parent still renders as its own top-level row, not nested under the parent's row.

## Two real bugs found and fixed during verification

Verifying this end-to-end (not just trusting unit tests) surfaced two bugs neither the normalizer tests nor the component tests caught, because both were **integration-shaped**: one broke the real GraphQL wire format, the other only showed up with real data at real column widths.

### Bug 1 — Invalid `//` comments inside the GraphQL template broke the production query

`itemContentSelection()` in `project-view.ts` had a JS-style `// Why: ...` comment sitting *inside* the GraphQL template literal. GraphQL only supports `#` comments — `//` is an `UNKNOWN_CHAR` parse error. Every real fetch for a project with `Issue` items failed silently at the GraphQL layer (`content: null` for all items), and the failure looked exactly like a permissions problem, which is what I initially misdiagnosed it as.

Reproduced directly against the API:

```
$ gh api graphql -f query='... subIssuesSummary { total completed percentCompleted } ... // Why: ... ...'
{"errors":[{"message":"Expected NAME, actual: UNKNOWN_CHAR (\"/\") at [12, 15]", ...}]}
```

Fix: moved the comment above the function as a normal TS comment (`project-view.ts:620-622`), keeping the GraphQL template comment-free. Verified the fixed selection set against the live API (`gh api graphql`) — returns full `content` for all 15 items, including `subIssuesSummary: {"total":3,"completed":0,"percentCompleted":0}` for issue #37.

**Why unit tests missed it**: `normalizeItem`'s tests feed hand-built `RawItem` objects directly — the query string itself was never round-tripped through anything GraphQL-aware. Closed this gap with a permanent regression test (see below) instead of trusting it won't happen again.

### Bug 2 — `SUB_ISSUES_PROGRESS` cell counter was invisible at default column width

Even after fixing the query, the "0/3" counter text was rendered in the DOM (confirmed via direct query — `textContent: "0/3"`, `visibility: visible`, non-zero bounding box) but was **entirely clipped by `overflow: hidden`**: the progress bar (`w-16` = 64px, `shrink-0`) alone consumed nearly the whole 60-70px default column width, leaving no room for the counter next to it before the container's `truncate` class clipped it.

Confirmed the exact geometry: text span `x=884.4`, cell right edge `x=884.2` — the text started *after* its own clipping boundary, i.e. 0% visible.

Fix, two parts:
1. `ProjectCell.tsx` — shrank the progress bar from `w-16` (64px) to `w-8` (32px) and the gap from `gap-1.5` to `gap-1`, so bar + gap + counter fits in ~57px of intrinsic content width.
2. `column-widths.ts` (single source of truth, exported `buildProjectGridTemplate`) / `ProjectViewList.tsx` / `ProjectRow.tsx` / `ColumnResizeHandle.tsx` — added a per-`dataType` minimum column width (`minColumnWidthFor`, 96px for `SUB_ISSUES_PROGRESS` vs. the generic 60px floor), applied consistently at both the initial grid-template computation and the drag-resize clamp (so a user can't manually drag the column back down to a size that re-clips the counter, and the resize pair math stays conserved instead of silently growing the row's total width). `ProjectViewList.tsx` previously had its own duplicate grid-template builder — consolidated into the shared, tested function so the regression test covers the code path the table actually renders with, not a parallel copy that could drift out of sync.

**Why component tests missed it**: `ProjectCell.test.tsx` renders the cell in isolation (no real grid/column-width context), so `toBeInTheDocument()` passes even when the real column width would clip it to 0 visible pixels. Isolation tests don't catch layout-context bugs by construction — this needed a real table render at real widths. Closed with a permanent regression test on the real width-computation path (see below).

## What was built

### Files changed

```
 src/main/github/project-view.ts                                          | +100 -19
 src/main/github/project-view.test.ts                                     | +180 -1
 src/shared/github-project-types.ts                                       | +25
 src/shared/github-project-group-sort.ts                                  | +8
 src/renderer/src/components/github-project/ProjectCell.tsx               | +88 -1
 src/renderer/src/components/github-project/ProjectCell.test.tsx          | new (5 tests)
 src/renderer/src/components/github-project/ProjectRow.tsx                | +4 -2
 src/renderer/src/components/github-project/ProjectViewList.tsx           | +7 -19
 src/renderer/src/components/github-project/ColumnResizeHandle.tsx        | +9 -4
 src/renderer/src/components/github-project/column-widths.ts              | +33 -3
 src/renderer/src/components/github-project/column-widths.test.ts         | new (4 tests)
 src/renderer/src/components/github-project/group-sort.test.ts            | +3 -2
 src/renderer/src/components/github-project/project-row-filtering.test.ts | +3 -2

 13 files changed, 461 insertions(+), 33 deletions(-)
```

### Three new fields on `GitHubProjectRow.content`

```ts
subIssuesSummary: { total: number; completed: number; percentCompleted: number } | null
trackedIssues: GitHubProjectParentIssue[]   // Issue.trackedIssues(first: 5)
trackedInIssues: GitHubProjectParentIssue[] // Issue.trackedInIssues(first: 5)
```

### Defensive forward-compat union variant

```ts
| { kind: 'issue-ref-list'; fieldId: string; direction: 'tracks' | 'tracked-by'; issues: GitHubProjectParentIssue[] }
```

No live `ProjectV2ItemFieldValue` union member maps to this today (12 members confirmed, none hierarchy-related) — this exists purely so the normalizer's default branch and the group-sort switch stay exhaustive if GitHub ever adds one.

### Exported named types / functions at the module boundary

```ts
// project-view.ts
export type RawFieldValue = { … }
export type RawContent = { … }
export type RawItem = { … }
export function itemContentSelection(includeParent: boolean): string
export const FIELD_CONFIG_FRAGMENT: string
export const FIELD_VALUES_SELECTION: string

// column-widths.ts
export function minColumnWidthFor(field: GitHubProjectField): number
export function buildProjectGridTemplate(fields, widths): string
```

### GraphQL selection (fixed)

```graphql
... on Issue {
  id number title url state stateReason
  repository { nameWithOwner }
  assignees(first:5) { nodes { login name avatarUrl } }
  labels(first:10) { nodes { name color } }
  issueType { id name color description }
  parent { number title url }
  subIssuesSummary { total completed percentCompleted }
  trackedIssues(first: 5) { nodes { number title url } }
  trackedInIssues(first: 5) { nodes { number title url } }
}
```

## Evidence

### 1. Schema verification (live introspection, 2026-07-14)

`ProjectV2ItemFieldValue.possibleTypes` = 12 members (date, iteration, label, milestone, number, pull-request, repository, reviewer, single-select, text, user, and the non-union `ProjectV2ItemIssueFieldValue` object). No sub-issue-progress/tracked-issues/tracked-by-issues member exists. GitHub also [deprecated the `Tracked`/`Tracked by` Project *fields* in Feb 2025](https://github.blog/changelog/2025-02-18-github-issues-projects-february-18th-update/) — the Issue-level `trackedIssues`/`trackedInIssues` are what survive.

### 2. Unit + integration test results (all real runs, this session, post-fix)

| Suite | Result |
|---|---|
| `src/main/github/project-view.test.ts` | 36 passed (27 pre-existing + 6 `normalizeItem` cases + 3 new GraphQL-syntax regression tests) |
| `src/renderer/.../ProjectCell.test.tsx` | 5 passed (new file) |
| `src/renderer/.../column-widths.test.ts` | 4 passed (new file, tests the real `buildProjectGridTemplate`) |
| `src/main/github` + `src/renderer/.../github-project` + `src/shared` (full sweep) | **2826 passed, 4 skipped, 0 failed** (277 files) |
| `pnpm tc:node` / `tc:cli` | clean |
| `pnpm tc:web` | clean except one pre-existing, unrelated Monaco editor type mismatch in `monaco-setup.ts` |

### 3. Live GraphQL verification (post-fix)

Sent the **actual fixed query string** extracted from `project-view.ts` (not a hand-written approximation) to `https://api.github.com/graphql` against `CodigoSinSiesta/1`:

```
15 items returned. Issue #37 content:
{
  "subIssuesSummary": { "total": 3, "completed": 0, "percentCompleted": 0 },
  "trackedIssues": { "nodes": [] },
  "trackedInIssues": { "nodes": [] },
  ...
}
```

### 4. Pipeline verification — real `normalizeItem` against real API data

Fed the exact raw JSON above into the actual (not reimplemented) `normalizeItem()` function via a throwaway vitest spec:

```
outcome.ok === true
outcome.row.content.number === 37
outcome.row.content.subIssuesSummary === { total: 3, completed: 0, percentCompleted: 0 }
```

1/1 passed. (Spec deleted after producing this evidence — not part of the permanent suite; the permanent regression coverage lives in the two new test files listed above.)

### 5. Visual evidence — real Orca app, real data, real render

Connected via CDP directly to a freshly-launched Orca dev build (`pnpm dev`, own process, no auth wall — distinct from the headless `browser` tool and from `computer-use`, both of which hit real environment limits: no GitHub session and `permission_denied` on macOS Accessibility respectively). Navigated the actual native "GitHub Project" panel (not a web page) to `CodigoSinSiesta/1` → "Prioritized backlog", and captured:

![Sub-issues progress rendering row #37 with a 0/3 counter](https://raw.githubusercontent.com/CodigoSinSiesta/codigosinsiesta.github.io/main/docs/phase-1b-evidence/orca-row37-fixed.png)

Row `#37` ("[Épica] Sección de blog en el sitio de Código Sin Siesta") shows the `Sub-issues progress` cell with a progress bar and `0/3` — matching the live API's `subIssuesSummary` exactly. Confirmed via direct DOM query (`role="progressbar"`, `textContent: "0/3"`) before the screenshot; the column-width fix (Bug 2 above) was required to make it visible instead of clipped to 0px.

## Permanent regression coverage added

- `project-view.test.ts` — `describe('GraphQL query fragment syntax', ...)`: asserts `itemContentSelection()`, `FIELD_CONFIG_FRAGMENT`, and `FIELD_VALUES_SELECTION` contain no `//` (invalid GraphQL comment syntax), plus a brace-balance check. Cheap syntax-shape guard, not a full GraphQL parser (the project has no direct `graphql` dependency to lean on), but it locks the exact failure mode that shipped in Bug 1.
- `column-widths.test.ts` (new file) — asserts `minColumnWidthFor(SUB_ISSUES_PROGRESS)` exceeds the generic floor, `resolveWidth` honors the per-field floor over a stored value that only clears the generic one, and `buildProjectGridTemplate` (the real function `ProjectViewList` renders with, not a parallel copy) emits the wider `minmax` floor for that column.

## Known limitations

- **`TRACKS`/`TRACKED_BY` columns** are usually empty in real projects since GitHub deprecated the corresponding Project *fields* in Feb 2025; the renderer works via the surviving `Issue.trackedIssues`/`trackedInIssues`, but most real-world projects won't populate it.
- **`Parent issue` column** doesn't appear in `CodigoSinSiesta/1`'s "Prioritized backlog" view because that view's own field list (configured on GitHub, not in Orca) doesn't include it — `getAvailableColumns` only surfaces fields the view exposes. Add it to the view's columns on GitHub to see it in Orca.

## References

- RFC: `docs/reference/2026-07-14-github-projects-hierarchy-traceability-design.md`
- Original plan (halted at step 5 on a false premise about union members): `local://github-projects-hierarchy-phase1-plan.md`
- Revised plan (this phase): `local://github-projects-hierarchy-phase1b-redirect-plan.md`
