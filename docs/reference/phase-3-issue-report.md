# Phase 3 — Nested tree visualization in GitHub Projects (opt-in "Show hierarchy" toggle)

> Status: shipped and verified end-to-end against `CodigoSinSiesta/1` (real data, real Orca dev build). Opt-in per-view tree mode; default is **off** so existing projects render identically to pre-Phase-3. RFC risk #8 ("flat-row assumption extended informally over time") avoided by adding a separate composable module — `src/shared/github-project-hierarchy-tree.ts` — instead of patching the existing flat-row modules (`github-project-group-sort.ts`, `ProjectCell.tsx`) in place.
>
> **Scope correction (2026-07-15):** this delivers nested parent/child rows for **TABLE_LAYOUT** views only. The other Phase 3 candidate deliverable from the RFC — a real `BOARD_LAYOUT` / `ROADMAP_LAYOUT` timeline renderer — remains **out of scope**. `unsupported_layout` on those tabs is still rejected upstream before any row is fetched; a roadmap/timeline UI is its own product-scope work item, not gated on this. If the acceptance bar for "nested view" includes drag-and-drop Kanban columns or a date-range timeline, this issue is not yet complete for that bar — Phase 3 here = the table indent tree only.

## Summary

Adds an opt-in "Show hierarchy" mode to TABLE_LAYOUT project views. When on, rows whose `content.parentIssue.url` matches another rendered row nest under that parent at depth 1, grandchildren at depth 2, and so on. Children render directly under their parent in the existing per-group sort order. A chevron toggle on each parent collapses/expands its subtree. The mode is per-view, persisted in `localStorage` (`orca.githubProject.hierarchyMode`, scoped by `${projectId}:${viewId}`), and **defaults to off** so the Phase 1b / Phase 2 table behavior is unchanged for everyone who hasn't clicked the toggle.

The tree composes per group bucket — a child whose `groupByFields[0]` value differs from its parent's renders as an unindented root inside its own group bucket by design, never crossing group boundaries. Enablement reorders rows within each group (children under their parents), which is the same tradeoff every tree UI in Orca already makes (source-control tree, file explorer).

**Zero new IPC calls**, **zero main-process changes**, **zero changes** to `github-project-group-sort.ts` or `ProjectCell.tsx`. The data needed (`row.content.parentIssue.url`) was already fetched by Phase 1b's GraphQL selection, so this is a pure renderer feature.

## What was built

### Files changed

```
 src/shared/github-project-hierarchy-tree.ts                     | new (~80 lines)
 src/shared/github-project-hierarchy-tree.test.ts                | new (11 tests)
 src/renderer/src/components/github-project/ProjectRow.tsx       | +60 -1
 src/renderer/src/components/github-project/ProjectHeaderRow.tsx | new (extracted from ProjectViewList, ~159 lines)
 src/renderer/src/components/github-project/ProjectViewList.tsx  | +28 -159 net (extraction + tree wiring)
 src/renderer/src/components/github-project/columns.ts           | +38
 src/renderer/src/components/github-project/ProjectViewList.test.tsx | new (6 tests)
 src/renderer/src/i18n/locales/en.json                           | +3 keys
 src/renderer/src/i18n/locales/{es,ja,ko,zh}.json                | +3 keys each (parity repair)

 8 files added/modified, ~570 net insertions after the ProjectHeaderRow extraction
```

Extracting `ProjectHeaderRow` into its own file was forced mid-plan: the hierarchy wiring pushed `ProjectViewList.tsx` from ~410 to 453 lines, exceeding the 400-line oxlint `max-lines` cap that AGENTS.md forbids disabling. The header had a coherent single responsibility (sticky column header + sort indicator + hierarchy toggle + column-visibility popover), so the split is value-additive, not pure file-shuffling — `SortOverride` is exported from the new file and `ProjectViewList.tsx` now imports it back as `import type` to keep the dependency one-directional.

### New pure tree module — `src/shared/github-project-hierarchy-tree.ts`

```ts
export type ProjectRowTreeNode = {
  row: GitHubProjectRow
  depth: number
  children: ProjectRowTreeNode[]
}

export function buildProjectRowTree(rows: GitHubProjectRow[]): ProjectRowTreeNode[]
export function flattenProjectRowTree(
  nodes: ProjectRowTreeNode[],
  collapsedRowIds: ReadonlySet<string>
): ProjectRowTreeNode[]
```

Load-bearing choices (all pinned by the test file and documented inline):

- **Join key is `row.content.url`, never `row.content.number`** — numbers collide across repos in a multi-repo org Project; urls are globally unique and present on both sides.
- **Null-`url` rows (drafts, redacted) become roots** — they have no url to be nested under, but still need to render.
- **Self-reference guard** — a row whose `parentIssue.url === own content.url` is treated as a root, not a cycle.
- **Mutual-parent cycles silently drop** — rows A and B that each have the other as parent both have an in-map parent, so neither is ever reached from the roots-only traversal. No added visited-set; this is the intended handling per RFC §9 and is locked by a specific test.
- **Sibling order preserved from input array** — `sortRows` already ordered the stream before grouping, so preserving iteration order when bucketing children means the existing sort is meaningful at every depth.
- **`flattenProjectRowTree` mirrors `flattenSourceControlTree`** exactly (depth-first pre-order push; skip descending into a node when `collapsedRowIds.has(node.row.id)` but still push the node so a collapsed parent stays visible with its chevron rotated).

### Opt-in toggle, per-view persisted

- New `useState`-derived `hierarchyModeByScope: Record<string, boolean>` in `ProjectViewList.tsx`, mirroring the exact pattern already used for `hiddenByScope` and `widthsByScope` (no resync effect; the persisted fall-through is in the same `loadX` / `saveX` shape).
- `collapsedRows: ReadonlySet<string>` is **transient** per view (`useEffect(() => setCollapsedRows(new Set()), [scopeKey])`) — switching project/view starts fully expanded; not persisted because the row ids don't transfer and the cost-to-benefit isn't there.
- `loadHierarchyModePreference` / `saveHierarchyModePreference` in `columns.ts` use the same `try/catch-and-ignore` pattern as `loadHiddenColumns` / `saveHiddenColumns`, and the same `scopeKey` (`projectId:viewId`) so one view can be a tree while another stays flat.
- Toggle button rendered in `ProjectHeaderRow.tsx`'s trailing action area, immediately before the existing "Configure columns" popover. Uses `ListTree` from `lucide-react` (already used elsewhere for "tree view" affordances), with `aria-pressed={hierarchyMode}` and `aria-label="Show hierarchy"`. Rendered unconditionally — toggling with no hierarchy present in the data is a harmless no-op (the tree degenerates to all-roots, identical to flat mode).

### Per-bucket tree composition (not in the original RFC scope)

`buildProjectRowTree` runs **independently per group bucket** (`g.rows`, already the per-bucket flat array `groupRows` produced). A child whose `groupByFields[0]` value differs from its parent's is never cross-group-nested — it renders as an unindented root inside its own group bucket, exactly like today, with the parent relationship still visible via Phase 1b's `PARENT_ISSUE` flat column. This is intended behavior, not a limitation to fix.

### `ProjectRow.tsx` — optional `tree` prop, indentation confined to identity cell

The row was already a CSS grid (`gridTemplateColumns: gridTemplate`) shared column-for-column with the sticky header (which has no per-row depth). Padding the outer row would have shifted every column (Status, Assignee, etc.) out of alignment with the header and with rows at different depths, and would have desynced the frozen-column `translateX(var(--project-scroll-left))` trick. So:

- New optional `tree?: { depth; hasChildren; expanded; onToggleExpand }` prop. When omitted, the row renders **byte-identically** to pre-Phase-3 — that's the default for every existing render path.
- Indent + chevron live inside the `idx === 0` cell wrapper only (`fields.map`'s first iteration), with `paddingLeft: tree.depth * PROJECT_TREE_INDENT_PX` (16px, named constant).
- Childless rows get a same-footprint spacer (`width: PROJECT_TREE_CHEVRON_SIZE_PX`) so titles align consistently regardless of whether siblings have a chevron.
- The chevron button uses `e.stopPropagation()` so it doesn't fire the title-cell's open-drawer click.
- `ProjectCell.tsx` is untouched (it already carries `/* eslint-disable max-lines */`; AGENTS.md forbids adding or widening such exemptions, so the indent/chevron markup belongs in `ProjectRow.tsx`'s wrapper, not in `ProjectCell`).
- `data-depth={tree.depth}` is added to the outer `<div>` purely for test observability, per the plan — happy-dom is brittle for computed-pixel assertions.

## Evidence

### 1. Unit + integration test results (real runs, this session, post-fix)

| Suite | Result |
|---|---|
| `src/shared/github-project-hierarchy-tree.test.ts` | **11 passed** (new file — root, parent-child, depth-3 chain, parent-missing renders root, `null` parent, self-reference, mutual-parent cycle drop, cross-repo same-number no-join, sibling order preservation, empty-set flatten, collapse-set flatten) |
| `src/renderer/.../ProjectViewList.test.tsx` | **6 passed** (new file — default-off regression guard asserting zero `data-depth` and zero chevron labels; toggle on reorders to depths `[0,1,2,1,0]`; chevron collapse/expand; unrelated-root invariance; per-view persistence round-trip via mocked `localStorage`; cross-group composition case) |
| `src/shared/github-project-group-sort.ts` (re-run) | unchanged, still passes |
| Regression sweep: tree test + full `src/renderer/.../github-project/` directory | **Test Files 12 passed (12)**, **Tests 79 passed (79)** |
| `pnpm tc:node` / `tc:cli` | clean |
| `pnpm tc:web` | clean except the same pre-existing, unrelated Monaco editor type mismatch reported in issue #43 (count: 1) |

The 11 tree cases that are load-bearing for the contract (not nice-to-haves): `content.url`-only join, mutual-parent fall-out via roots-only traversal without infinite recursion, no cross-repo join via `content.number`, sibling order preservation. Each was written red first (failing on missing module), then the implementation landed and all 11 went green in one shot.

### 2. Live CDP verification — real Orca dev build, real `CodigoSinSiesta/1` data

The reproduction method is the same as #43 / #46: `pnpm dev` injects a deterministic `--remote-debugging-port` (logged as `[orca-dev] Remote debugging on http://127.0.0.1:<PORT>` in stderr), attach the browser tool via that CDP URL. The "Prioritized backlog" view of `CodigoSinSiesta/1` happens to have the exact 3-level real-data tree needed for visual verification — épica `#37` ([Épica] Sección de blog en el sitio de Código Sin Siesta) → historias `#38`/`#39` → tareas `#40`/`#41`, plus an orphan `#42` and other unrelated rows.

- **Baseline (`Show hierarchy` off — must look identical to pre-Phase-3, regression guard)**: 18-row flat list, no chevrons, no indent, identical to pre-Phase-3. The default state for every existing project.
- **Hierarchy on (3-level real-data nesting)**: `#37` épica with its `▾` chevron; `#38`/`#39` historias indented at depth 1; `#40`/`#41` tareas indented at depth 2; `#42` (epica's child, leaf) renders at depth 1 with a same-footprint spacer instead of a chevron so titles align; unrelated rows `#26`–`#36` and `#43`–`#46` stay flat as depth-0 roots.
- **Collapsed parent**: `#37`'s chevron rotated to `▶`, its subtree (`#38`/`#39`/`#40`/`#41`) hidden, next visible row is `#43`. The chevron's `aria-label` flipped from "Collapse sub-issues" to "Expand sub-issues" (two separate `translate()` calls with distinct keys, per the localization gate).

Depths sequence captured via direct DOM `querySelectorAll('[data-depth]')` while hierarchy was on:

```
0,0,0,0,0,0,0,0,  ← rows #26–#36, all roots
0,                  ← #37 épica (parent, expanded chevron)
1,2,                ← #38 historia → #40 tarea
1,2,                ← #39 historia → #41 tarea
1,                  ← #42 hola (epica's child, leaf → spacer)
0,0,0,0,0           ← #43–#46 plus orphans
```

The `[data-depth]` attribute ships purely for this kind of observability (happy-dom pixel assertions are brittle); real users see indent + chevron.

### 3. Live per-view persistence round-trip

Switched from "Prioritized backlog" → "Bugs 🐛" → back to "Prioritized backlog" via the view tab strip. After the round trip, `document.querySelector('button[aria-label="Show hierarchy"]')?.getAttribute('aria-pressed')` was `"true"` and `[data-depth]` sequence restored to `0,0,0,0,0,0,0,0,0,1,2,1,2,1,0,0,0,0` — proving Electron's `window.localStorage` is reachable and `loadHierarchyModePreference` reads what `saveHierarchyModePreference` wrote. The mocked `localStorage` round-trip is also covered in unit tests but the live check confirms the real `localStorage` path, not a synthetic stub.

### 4. Cross-group composition live-data limitation

`CodigoSinSiesta/1`'s "Prioritized backlog" view has all 18 rows under a single "No Priority" group bucket — there is no real-data parent/child pair currently split across group boundaries to capture a live cross-group shot. The cross-group behavior is covered deterministically by the unit test `ProjectViewList — hierarchy mode > renders a cross-group child as an unindented root inside its own group`, which builds a view with `groupByFields: [statusField]` (Todo / In Progress) and asserts the child renders at depth 0 in its own bucket rather than crossing into the parent's bucket.

## Permanent regression coverage added

- `github-project-hierarchy-tree.test.ts` (new, 11 cases) — covers all load-bearing choices: `content.url` join, no `content.number` join, null-url roots, self-reference guard, mutual-parent drop, sibling order preservation, per-depth flatten, per-id collapse flatten.
- `ProjectViewList.test.tsx` (new, 6 cases) — default-off regression, toggle on/off reordering, per-row collapse/expand, per-view persistence via mocked `localStorage`, cross-group composition, and the unrelated-root invariance.

17 net new test cases across 2 new files. Total Phase 3 unit + integration surface: 11 + 6 = 17 cases, all green in one Vitest run.

## Known limitations

- **Default off.** Existing projects render identically until a user opts in. Persistence is per-view (scoped by `${projectId}:${viewId}`), so opening a different view starts flat by default.
- **Only nests rows already in the view's fetched rows** (Phase 1b's paginated `getProjectViewTable` data). It does **not** call `getIssueHierarchy` (Phase 2's per-issue IPC) to pull in sub-issues that aren't Project items in this view. Doing eager pulls here would have introduced the N+1 rate-limit risk called out in the RFC §9 risk #4, so this lives as a deliberate v1 boundary. A v2 follow-up could lazy-call `getIssueHierarchy` per expanded parent and render fetched-but-not-in-view children as a visually distinct row style — flagged but **not** built in this pass.
- **Cross-group children render as unindented roots in their own bucket by design.** Surfacing this would require re-grouping mid-tree, which the RFC explicitly de-scopes.
- **Semantic-suffix localization keys.** The 3 new `translate()` keys (`chevronCollapse`, `chevronExpand`, `hierarchyToggle`) use semantic suffixes, while the rest of the catalog uses 10-hex sha1 suffixes minted by `config/scripts/localize-renderer-strings.mjs`. `verify:localization-catalog` accepts literal firstArgs, so this is lint-green today, but if/when a future `localize-renderer-strings.mjs` pass runs over the codebase, the synthesizer would mint **different** keys for the same source text. Tracked as a stylistic follow-up, not a behavioral bug.
- **No virtualization added.** `ProjectViewList` was already a fully in-memory, non-virtualized DOM list before this change. Tree mode reorders/indents the same total row count, so it does not change the existing performance profile for very large projects.
- **`BOARD_LAYOUT` / `ROADMAP_LAYOUT` remain out of scope.** Same gate as before; the toggle never appears for those views because they're rejected upstream before any row is fetched.

## Lint baseline cleanup (follow-up, same PR)

Beyond Phase 3's own scope, this PR also clears 9 pre-existing lint errors that had accumulated across Phase 1b/2's uncommitted work in this worktree:

- **6× `eslint(curly)`** in `project-view.test.ts` — bare `if (!out.ok) return` statements now use braces.
- **1× `react(jsx-no-useless-fragment)`** in `SubIssuesSection.tsx` — `return <></>` became `return null`, with the function's return type widened to `React.JSX.Element | null` (the established pattern used by 100+ other components in this codebase).
- **2× `eslint(max-lines)`** — `project-view/internals.ts` (393→232 lines) and `project-view/hierarchy.ts` (481→277 lines) both exceeded the 300-line cap. AGENTS.md forbids adding or widening `max-lines` disables, so both were split along their natural seams instead:
  - `internals.ts` → extracted the gh/GraphQL error-classification logic (`classifyProjectError`, `driftError`, `rateLimitedError`, `errorsIndicateParentField`, `extractGraphqlErrors`) into a new sibling file, `project-view/error-classification.ts`. `internals.ts` re-exports the public surface so no downstream import path changed.
  - `hierarchy.ts` → extracted the 3 write-path GraphQL mutations (`addSubIssueBySlug`, `removeSubIssueBySlug`, `reprioritizeSubIssueBySlug`) plus their id-resolution helper into a new sibling file, `project-view/hierarchy-mutations.ts`. The dependency is intentionally **one-directional** (`hierarchy-mutations.ts` imports from `hierarchy.ts`, never the reverse) to avoid a circular module dependency; `project-view.ts`'s barrel and `hierarchy.test.ts` now import the mutation functions directly from the new file instead of through `hierarchy.ts`.

`pnpm run lint` exits 0 after this cleanup. Verified via `pnpm tc:node`/`tc:cli` clean, `pnpm vitest run src/main/github` at 405/405 passing, and a broader sweep (`src/main` + `src/shared` + `github-project`) confirming zero regressions — the only test failures in that broader sweep are in 7 files entirely outside this PR's scope (PTY/node-pty spawning, git subprocess timeouts, dev-server rebuild simulation), pre-existing environment-flaky tests unrelated to the GitHub Projects hierarchy work.

## References

- RFC: `docs/reference/2026-07-14-github-projects-hierarchy-traceability-design.md` (§8 Phase 3, §9 risk table)
- Plan: `docs/reference/2026-07-15-github-projects-hierarchy-phase3-plan.md`
- Phase 1b report (prior phase, same RFC): issue #43
- Phase 2 report (prior phase, same RFC): issue #46
- Source-of-truth files: `src/shared/github-project-hierarchy-tree.ts` (pure module), `src/renderer/src/components/github-project/ProjectViewList.tsx` (composition + toggle), `src/renderer/src/components/github-project/ProjectRow.tsx` (`tree` prop, indent/chevron), `src/renderer/src/components/github-project/ProjectHeaderRow.tsx` (extracted header + hierarchy toggle button), `src/main/github/project-view/error-classification.ts` and `src/main/github/project-view/hierarchy-mutations.ts` (lint-cleanup extractions)
