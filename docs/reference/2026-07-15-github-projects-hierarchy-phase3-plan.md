# GitHub Projects Hierarchy — Phase 3: nested tree visualization

## Context

The RFC (`docs/reference/2026-07-14-github-projects-hierarchy-traceability-design.md`, §8 "Phase 3 — True nested/roadmap visualization") named two candidate deliverables: an indentation/expand-collapse tree, and/or a roadmap-style timeline. This plan ships the tree — the RFC's own risk note says a genuine roadmap/timeline is "largely product-scope risk" requiring its own design pass, and Board/Roadmap layouts still return `unsupported_layout` from `getProjectViewTable` (`src/main/github/project-view.ts`) before any row is fetched; that gate is untouched by this plan (see Assumptions).

Code inspection found the premise "Orca assumes every project looks like the flat `CodigoSinSiesta/1` test project" is **already false for `TABLE_LAYOUT` views**: `project-view.ts` queries each view's real `layout`, `groupByFields`, and `sortByFields` from GitHub's GraphQL `ProjectV2View` type, and `finalizeView()` normalizes them onto `GitHubProjectTable.selectedView`; `src/shared/github-project-group-sort.ts`'s `groupRows`/`sortRows` already bucket and order rows using that real per-view config, not a hardcoded shape. So a project grouped by Status, or sorted by a custom field, already renders correctly today. The one genuine per-row-structure gap is what the RFC flagged: **no parent-child nesting** — `GitHubProjectRow` is flat, and `ProjectGroup.rows` is a flat array with no `children`.

This plan closes that gap: a new opt-in "Show hierarchy" tree mode for `TABLE_LAYOUT` views that nests a row under its parent when both are rows in the same rendered group, using data Orca already fetches (Phase 1b's `row.content.parentIssue`/`content.url`) — **zero new IPC calls, zero main-process changes, zero changes to `github-project-group-sort.ts` or `ProjectCell.tsx`**. This directly avoids RFC risk #8 ("flat-row assumption... extended informally over time") by adding a separate, composable module instead of patching the flat-row modules in place.

## Approach

### 1. Pure tree-building module (no dependents yet — safe first step)

`src/shared/github-project-hierarchy-tree.ts`, a new pure module (kebab-case, domain-named — sibling to `github-project-group-sort.ts`, not folded into it, so the existing flat grouping/sorting contract stays untouched):

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

`buildProjectRowTree` behavior (all load-bearing, pinned by tests):

- Join key is `row.content.url`, **never** `content.number` — a row's own identity is `row.content.url`, and `GitHubProjectParentIssue` carries `url`. Using `number` would collide across repos in a multi-repo org Project.
- Build `byUrl: Map<string, GitHubProjectRow>`, skipping rows where `content.url` is `null` (draft issues / redacted items never become nesting parents — they still appear as roots).
- A row becomes a **child** only when `row.content.parentIssue` is non-null, the parent exists in `byUrl`, and `parent !== row` (self-parent guard). Otherwise the row is a **root** (depth 0) — covers no-parent, parent-filtered-out, and self-reference uniformly.
- Cycle safety: mutual parents (A→B, B→A) leave both with an in-map parent, so neither is ever visited from the roots-only traversal — both are silently dropped rather than causing infinite recursion. Not "fixed" into rendering some other way; covered by a dedicated test.
- Sibling order is preserved from the input array (rows already arrive sorted via `sortRows`).
- Complexity: two O(n) passes to build the maps, one O(n) recursive build from roots. No N² behavior.

`flattenProjectRowTree` mirrors `flattenSourceControlTree` (`src/renderer/src/components/right-sidebar/source-control-tree.ts`) exactly: depth-first pre-order push, skip descending into a node's `children` when `collapsedRowIds.has(node.row.id)`, but still push the node itself (so a collapsed parent stays visible with its chevron collapsed).

### 2. Tests for the tree module (written before the implementation exists — TDD)

`src/shared/github-project-hierarchy-tree.test.ts`, mirroring `group-sort.test.ts`'s fixture builder but with real distinct `content.url`/`content.parentIssue` values. Cases: root with no children; parent + one child; parent + child + grandchild (depth chain); child whose parent url matches nothing (renders root, not dropped); `parentIssue: null` (root); self-referential row (root, not an infinite loop); two mutually-parented rows (both absent from `roots`); same `content.number` across two rows with different `content.url` (must NOT join); sibling order preservation; `flattenProjectRowTree` with empty and non-empty collapsed sets.

Run red first, confirm all fail (module doesn't exist), then implement step 1 and confirm all pass.

### 3. `ProjectRow.tsx` — optional `tree` prop, indentation confined to the identity column

Add one new optional prop instead of four separate ones, so the current call site keeps working with zero prop changes when omitted:

```ts
type ProjectRowTreeProps = {
  depth: number
  hasChildren: boolean
  expanded: boolean
  onToggleExpand: () => void
}
```

`tree?: ProjectRowTreeProps` on `Props`. When `tree` is `undefined`, the row renders **exactly as it does today** — no indent, no chevron, no behavior change. This is the default for every existing render path.

Indentation lives **inside the first field cell's wrapper only** (the `idx === 0` iteration of the `fields.map` loop) — never as `paddingLeft` on the outer row `<div>`. The outer row is a CSS grid shared column-for-column with the sticky header (which has no per-row depth); padding the whole row would shift every column out of alignment with the header and with sibling rows at a different depth, and would desync the frozen-column `translateX(var(--project-scroll-left))` trick.

Named constants: `PROJECT_TREE_INDENT_PX = 16`, `PROJECT_TREE_CHEVRON_SIZE_PX = 14`. Chevron reuses `ChevronDown`/`ChevronRight` from `lucide-react` exactly as `ProjectGroupHeader.tsx` does. `e.stopPropagation()` on the chevron click prevents it from bubbling into the title cell's own drawer-open click handling. `ProjectCell.tsx` is not modified at all — it already carries `/* eslint-disable max-lines */` and AGENTS.md forbids adding or widening such exemptions.

Known pre-existing, out-of-scope issue: `ProjectRow.tsx` and `ProjectViewList.tsx` both hardcode `frozen = idx < 2` assuming index 0 is TITLE and index 1 is the synthetic Type column injected by `getAvailableColumns`. Not fixed by this plan.

### 4. `ProjectViewList.tsx` — toggle, per-row collapse state, tree composition

**State**: `hierarchyModeByScope: Record<string, boolean | undefined>` mirrors the exact `hiddenByScope`/`widthsByScope` pattern (derived-state-with-persisted-fallback, not a plain `useState` + resync effect). `collapsedRows: ReadonlySet<string>` resets on `scopeKey` change (switching project/view starts with everything expanded).

**Persistence**: `loadHierarchyModePreference`/`saveHierarchyModePreference` in `columns.ts`, same `scopeKey`-keyed localStorage convention as `loadHiddenColumns`/`saveHiddenColumns`, new key `orca.githubProject.hierarchyMode`. Default `false` — this is the safe default: zero visual change to any existing project until a user opts in per view.

**Toggle button**: added to `ProjectHeaderRow`'s trailing action area, immediately before the "Configure columns" popover. Uses `ListTree` from `lucide-react` (already used elsewhere in the codebase for the same "tree view" affordance). Rendered unconditionally — toggling with no hierarchy present in the data is a harmless no-op (the tree degenerates to all-roots, identical to flat mode).

**Composition with grouping/sorting**: does not touch `groupRows`/`sortRows` or their inputs/outputs. A new derived value runs `buildProjectRowTree`/`flattenProjectRowTree` **per group bucket** (`g.rows`, already the per-bucket flat array `groupRows` produced) — a child row whose `groupByFields[0]` value differs from its parent's is never cross-group-nested; it appears as an unindented root within its own group, exactly like today, with its parent relationship still visible via the existing `PARENT_ISSUE` column (Phase 1). This is intended behavior, not a limitation to fix.

Enabling hierarchy mode changes row **order**, not just indentation: a child always renders directly beneath its parent, which can move it out of its flat, absolute sort position relative to unrelated rows — the same tradeoff every tree UI in this app already makes (source-control tree, file explorer).

**Render loop**: branches on `hierarchyMode`, keeps the existing flat path byte-for-byte when off.

### 5. Tests for `ProjectViewList.tsx`

New `ProjectViewList.test.tsx` (no prior dedicated test file existed for this component). Build a `GitHubProjectTable` fixture with a parent row + two direct children (one further nested grandchild) + one unrelated root row. Cover: toggle renders off by default with the row list identical to a never-clicked render (regression guard); clicking the toggle nests rows with chevrons and correct depths; clicking a parent's chevron collapses/re-expands its subtree; the unrelated root renders identically on/off; persistence across unmount/remount via a stubbed in-memory `localStorage`; a grouped view where a child's group differs from its parent's renders the child as an unindented root in its own group.

Run red first (import errors / missing toggle) before wiring step 4, then green after.

### 6. Full regression + typecheck

After steps 1-5 are green individually: `pnpm tc:node && pnpm tc:cli && pnpm tc:web`, full vitest sweep on the tree module + `github-project-group-sort.ts` + the whole `github-project` component directory, then `pnpm run sync:localization-catalog` so the new `translate()` calls (chevron `aria-label`, hierarchy toggle `aria-label`) get real catalog entries instead of relying on the fallback string — the lint gate runs `verify:localization-catalog` and fails on unminted keys.

## Critical files & anchors

- `src/shared/github-project-types.ts` (`GitHubProjectRow`, `GitHubProjectParentIssue`) — the exact shape the new tree module joins on; confirms no schema change is needed.
- `src/shared/github-project-group-sort.ts` (`groupRows`) — confirms grouping is already per-view-driven and single-field (`groupByFields[0]`); the new tree module must compose per-bucket and never touch this function.
- `src/renderer/src/components/github-project/ProjectViewList.tsx` — the `groups` memo and render loop the tree composition step must slot into without disturbing the non-hierarchy path.
- `src/renderer/src/components/github-project/ProjectRow.tsx` — the CSS grid row structure that constrains indentation to the `idx === 0` cell wrapper, not the outer row.
- `src/renderer/src/components/right-sidebar/source-control-tree.ts` (`flattenSourceControlTree`) — the exact flatten-with-collapsed-set algorithm `flattenProjectRowTree` must mirror.

## Verification

1. `src/shared/github-project-hierarchy-tree.test.ts` — all pure-function cases pass, including the mutual-parent-cycle case returning `[]` and the cross-repo-number-collision case NOT nesting.
2. `ProjectViewList.test.tsx` — toggle, nesting, collapse/expand, persistence, and grouped-view composition cases all pass.
3. `pnpm tc:web` — zero new TS errors beyond the pre-existing Monaco `editor.create` incompatibility from prior phases.
4. Manual verification against a real project with real parent/child data: launch `pnpm dev`, connect via CDP, navigate to a Project with issues that have sub-issues that are ALSO Project items in the same view. Screenshot hierarchy off (baseline), hierarchy on (indented children with chevrons), a collapsed parent, and (if the view groups) a cross-group child rendering unindented in its own bucket.
5. `pnpm run lint` (includes `verify:localization-catalog`) passes after `pnpm run sync:localization-catalog`.

## Assumptions & contingencies

- **Board/Roadmap layouts remain out of scope.** The `unsupported_layout` gate in `project-view.ts` and the disabled tabs in the UI are untouched. Building an actual Kanban-column or timeline renderer is a different UI paradigm from an indent tree and matches the RFC's own recommendation to gate it behind a separate design pass.
- **v1 tree only nests rows already present in the current view's fetched rows** (Phase 1b's paginated `getProjectViewTable` data) — it does not call `getIssueHierarchy` (Phase 2's per-issue IPC) to pull in sub-issues that aren't Project items in this view. A v2 follow-up could lazy-call `getIssueHierarchy` per expanded parent row and render fetched-but-not-in-view children as a visually distinct row style — explicitly not built now to avoid the N+1 rate-limit risk the RFC's own risk table flags.
- **No changes to `github-project-group-sort.ts`'s multi-level grouping limit** (`groupByFields[0]`-only) — a real, pre-existing gap, orthogonal to parent/child hierarchy, not fixed here.
- **No virtualization added.** `ProjectViewList` was already a fully in-memory, non-virtualized DOM list before this plan; tree mode reorders/indents the same total row count, so it does not change the existing performance profile for very large projects.
