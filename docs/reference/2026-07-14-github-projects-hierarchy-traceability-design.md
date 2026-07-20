# RFC: GitHub Projects hierarchy, traceability, and completion progress in Orca

**Date:** 2026-07-14
**Scope:** Orca GitHub integration (`src/main/github/*`, `src/shared/github-project-types.ts`, `src/renderer/src/components/github-project/*`, `src/main/ipc/github.ts`, `src/preload/api-types.ts`)
**Status:** Draft — for review

## 1. Executive summary

This RFC evaluates whether Orca should incorporate richer GitHub Projects traceability — epics, stories, nested tasks, parent-child hierarchy, and completion percentage — comparable to the GitHub web Projects experience.

Key findings:

- GitHub exposes the required primitives, but across **two related but distinct API surfaces**: ProjectsV2 (GraphQL-only) for project views/fields/items, and Issue hierarchy (GraphQL on `Issue`, plus REST sub-issues endpoints) for parent-child relationships and progress.
- **This is not a greenfield feature.** Orca already has a substantial partial ProjectsV2 integration: GraphQL-based table rendering, custom field support, and a shared type contract that already names `PARENT_ISSUE`, `SUB_ISSUES_PROGRESS`, `TRACKS`, and `TRACKED_BY` as known field data types.
- Orca currently renders **only the Table project-view layout**; Board and Roadmap are detected and explicitly surfaced as "unsupported_layout".
- Orca's GraphQL field-value fetch (`FIELD_VALUES_SELECTION`) and normalizer (`normalizeFieldValue`) do **not** request or hydrate the hierarchy/progress field-value shapes, and unknown value `__typename`s are **silently dropped** by design (forward-compat safety net). This means hierarchy/progress data can be invisible today even where GitHub already returns it.
- Orca's row/grouping model (`ProjectRow.tsx`, `github-project-group-sort.ts`) is a **flat table**, with no tree/indentation/expand-collapse concept. Real nested epic→story→task visualization is a new UI surface, not an incremental extension.

Recommendation: **proceed in three phases** of increasing effort/risk, each independently shippable and each providing standalone user value:

1. **Phase 1 — Traceability in the existing table** (low-medium effort, low-medium risk): extend the shared contract, GraphQL selection, normalization, and `ProjectCell` rendering to correctly surface Parent issue, Sub-issue progress, Tracks, and Tracked-by as read-only columns in the table view Orca already renders.
2. **Phase 2 — Hierarchy-aware interactions** (medium-high effort, medium risk): recursive roll-up beyond one level, issue-level hierarchy reads/writes (add/remove/reorder sub-issues) via REST, and grouping/filtering by parent.
3. **Phase 3 — True nested/roadmap visualization** (high effort, higher risk): a new tree-row model, expand/collapse, and/or a roadmap-like timeline view — functionally and architecturally a new feature, not a Project-table enhancement.

## 2. Problem statement

GitHub's web Issues + Projects experience already covers workflows directly relevant to Orca's planning and traceability needs: linking issues into parent-child hierarchies, representing epics/stories/tasks as nested work items, showing roll-up completion progress, and grouping/filtering by parent issue across table/board/roadmap views.

The user asked Orca to evaluate incorporating comparable capabilities, given that Orca already has GitHub integration. The central question this RFC answers is not "can GitHub's API do this?" (it can, in large part) but:

> Given Orca's existing GitHub integration and its existing partial ProjectsV2 implementation, what additional API consumption, shared-contract changes, normalization work, and UI work are required to deliver meaningful hierarchy/progress support — and where does the effort curve bend sharply upward?

## 3. Goals / Non-goals

**Goals**

- Evaluate GitHub API options for epics/stories/nested tasks, hierarchy, and completion percentage.
- Compare those options against Orca's current architecture and identify concrete gaps.
- Identify which GitHub web capabilities Orca should incorporate first for the best value/effort ratio.
- Propose a phased technical design with effort, risk, and architectural impact for each phase.

**Non-goals**

- Ship code. This is a design/evaluation document.
- Reproduce the GitHub Projects web UI pixel-for-pixel.
- Commit to Board/Roadmap layout support (out of scope; noted as a larger follow-on).
- Assert GraphQL schema shapes beyond what was verified against the official schema/docs in this session; anything not verified is explicitly flagged as "to confirm in a spike."

**Research limitation to flag explicitly**: the example panel URL provided by the user (`https://github.com/orgs/CodigoSinSiesta/projects/1/views/1`) returned an HTTP 404 during this investigation (verified via both the `read` tool and a headless browser). It could not be used as functional evidence; this RFC instead relies on official GitHub documentation, the public GraphQL schema SDL, and REST API references, cross-checked against Orca's current code.

## 4. What GitHub web currently covers that Orca should incorporate

From GitHub Issues + Projects, the capabilities most relevant to Orca are:

| Capability | GitHub web behavior | Priority for Orca |
|---|---|---|
| Parent issue field | Hidden-by-default Project field; shows which epic/story an item belongs to; usable for grouping/filtering | High — directly requested, cheapest to reach |
| Sub-issue progress field | Hidden-by-default Project field; shows a progress bar/pill of child completion | High — directly requested, data is already computed by GitHub |
| Native sub-issue hierarchy | Structured parent-child relation (not Markdown parsing); up to 8 levels deep, 100 children/issue | High — source of truth for hierarchy |
| Tracked / tracked-by | Looser tracking relationship (legacy tasklist-derived) | Medium — secondary signal, being superseded by sub-issues |
| Rich field composition | Status, iteration, dates, priority, assignees, labels, milestone, issue type | Already largely supported by Orca |
| Table / Board / Roadmap views | Different visualizations of the same underlying data | Board/Roadmap = separate, larger initiative; Table already exists in Orca |

## 5. Verified external API capabilities

### 5.1 GraphQL — ProjectsV2 (project-level data)

Verified against `docs.github.com` guides and the official public GraphQL schema SDL (`docs.github.com/public/fpt/schema.docs.graphql`):

- ProjectsV2 is **GraphQL-only** — there is no REST API for reading/writing Project boards, fields, or items themselves (REST `/projects` only covers the deprecated Projects "classic").
- Core objects: `ProjectV2`, `ProjectV2Item` (`type`: `ISSUE`/`PULL_REQUEST`/`DRAFT_ISSUE`/`REDACTED`), `ProjectV2ItemFieldValue` (a union with ~11 concrete value types), `ProjectV2FieldConfiguration` (`ProjectV2Field` / `ProjectV2SingleSelectField` / `ProjectV2IterationField`).
- `ProjectV2FieldType` enum includes both custom types (`TEXT`, `NUMBER`, `DATE`, `SINGLE_SELECT`, `ITERATION`) and system/builtin types, among them `PARENT_ISSUE`, `TRACKS`, `TRACKED_BY`, `SUB_ISSUES_PROGRESS`, `ISSUE_TYPE`.
- Items are paginated by cursor (`first`/`last` 1–100, `pageInfo.hasNextPage`/`endCursor`), matching the pattern Orca's `project-view.ts` already implements.
- `updateProjectV2ItemFieldValue` does **not** cover Assignees/Labels/Milestone/Repository — those require separate Issue/PR mutations. A "full" item update already requires multiple round trips; this is consistent with how Orca's `project-view/mutations.ts` is already structured (per-concern mutation functions).
- Rate limiting: 5,000 pts/hour (10,000 for GHEC org-owned tokens), secondary limits (100 concurrent requests, 2,000 pts/min), a hard 500,000-node cap per call, and a **hard 10s server-side timeout** that produces intermittent 502/504 on large/complex queries — community-documented mitigation is shrinking `first` page sizes, which matches constants Orca already tunes in `project-view.ts` (`ITEM_PAGE_SIZE`, `FIELD_VALUES_PAGE_SIZE`, etc.).
- Webhooks (`projects_v2`, `projects_v2_item`, `projects_v2_status_update`) exist **only for organization-owned projects**, not user or repo-owned projects — no push-based sync path is available for personal projects; polling is required there regardless of design choice.

### 5.2 GraphQL — Issue hierarchy (issue-level data)

Verified directly by reading the official public GraphQL schema SDL in this session (`Issue` object, lines ~20320–20520):

```graphql
type Issue {
  parent: Issue
  subIssues(first: Int, last: Int, before: String, after: String): IssueConnection!
  subIssuesSummary: SubIssuesSummary!
  trackedIssues(first: Int, last: Int, before: String, after: String): IssueConnection!
  trackedInIssues(first: Int, last: Int, before: String, after: String): IssueConnection!
  trackedIssuesCount(states: [TrackedIssueStates]): Int!
}
```

`subIssuesSummary` references a `SubIssuesSummary` type; the schema confirms a `percentCompleted`-oriented progress summary is associated with sub-issues (cross-checked against the REST shape below, which is fully confirmed). The complete field-by-field shape of `SubIssuesSummary` beyond `total`/`completed`/`percentCompleted` (as mirrored from the REST object) should be re-confirmed in an implementation spike before being hard-coded into a normalizer, since it was not read verbatim from the SDL body in this session.

Example query pattern (from official guidance; field names for `parent`/`subIssues`/`subIssuesSummary` are schema-verified, but the inner shape of `subIssuesSummary` shown below — `total`/`completed`/`percentCompleted` — is inferred by mirroring the fully-confirmed REST `sub_issues_summary` object, NOT independently read from the GraphQL SDL body in this session; treat that inner shape as unconfirmed until the spike in §8.1 runs a live query):

```graphql
query EpicHierarchy($owner: String!, $repo: String!, $epicNumber: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $epicNumber) {
      title
      number
      state
      subIssuesSummary { total completed percentCompleted }
      subIssues(first: 50) {
        nodes {
          title
          number
          state
          subIssuesSummary { total completed percentCompleted }
          parent { number title }
        }
      }
    }
  }
}
```

Important limitation: GraphQL does not support arbitrary-depth recursion in a single query. Hierarchies of unknown depth require either (a) manually nesting `subIssues { subIssues { ... } }` up to a fixed practical depth (2–3 levels covers epic→story→task), with lazy client-side pagination for deeper trees, or (b) issuing follow-up queries per node. GitHub also does **not** provide a single field that aggregates percent-complete recursively across an entire multi-level tree — each level only summarizes its direct children, so a "whole-epic-tree" percentage must be computed client-side.

**Verification status recap for this subsection:** confirmed directly in the public GraphQL SDL — `Issue.parent`, `Issue.subIssues`, `Issue.subIssuesSummary: SubIssuesSummary!`, `Issue.trackedIssues`, `Issue.trackedInIssues`, `Issue.trackedIssuesCount`, and the existence of a `percentCompleted`-oriented `SubIssuesSummary` type. NOT independently confirmed in this session — the full field list of `SubIssuesSummary` (assumed `total`/`completed`/`percentCompleted` by analogy with the verified REST shape in §5.3). Any implementation must re-verify the exact GraphQL field names with a live query before shipping.

### 5.3 REST — sub-issues (mutation/ordering surface)

Verified directly against `docs.github.com/en/rest/issues/sub-issues` in this session:

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/repos/{owner}/{repo}/issues/{issue_number}/parent` | Read parent issue |
| GET | `/repos/{owner}/{repo}/issues/{issue_number}/sub_issues` | List sub-issues (paginated) |
| POST | `/repos/{owner}/{repo}/issues/{issue_number}/sub_issues` | Add a sub-issue |
| DELETE | `/repos/{owner}/{repo}/issues/{issue_number}/sub_issue` | Remove a sub-issue |
| PATCH | `/repos/{owner}/{repo}/issues/{issue_number}/sub_issues/priority` | Reorder a sub-issue |

The standard Issue REST object also embeds, confirmed by reading the schema response body: `sub_issues_summary: { total, completed, percent_completed }` and `parent_issue_url`.

Architectural implication: REST is the practical surface for **mutating** hierarchy (add/remove/reorder), while GraphQL is the practical surface for **reading** it efficiently alongside Project field data in a single round trip. This dual-surface reality mirrors Orca's existing pattern of mixing `gh api graphql` and `gh api <rest-path>` calls in the same feature area.

### 5.4 Timeline, limits, and availability (context for scoping)

From cross-referenced official sources gathered in this session:

- Sub-issues reached General Availability on 2025-04-09, alongside an increase of the Projects item cap from 1,200 to 50,000 items.
- Hard limits: **8 levels of nesting**, **100 sub-issues per parent**, and **one parent per issue** (strict tree, not a DAG). GitHub has stated no plans to raise the 100-child limit.
- Cross-repository sub-issues are supported; cross-organization support was added in the September 2025 update, which also made sub-issues inherit their parent's Project/Milestone by default.
- Availability by plan tier is not explicitly tabulated in the public docs reviewed; general availability across Free/Team/Enterprise Cloud is the working assumption, but GitHub Enterprise Server parity should be verified in a spike if Orca needs to support GHES.
- Auth/scopes: PAT classic needs `project` (read/write) or `read:project`; fine-grained PAT needs the org permission `organization_projects` but **cannot** access user-owned Projects (an officially acknowledged gap); GitHub Apps need the org "Projects" permission and likewise cannot reach user-owned Projects. This matches — and explains — Orca's existing `REQUIRED_SCOPES = ['project', 'read:org', 'repo']` and its `gh auth refresh -s project ...` remediation message in `src/main/github/auth-diagnose.ts` / `project-view/internals.ts`.

## 6. Orca current state (direct code inspection)

### 6.1 Integration model

Orca does not use Octokit or any GitHub SDK. All GitHub access shells out to the user's `gh` CLI via a shared runner (`ghExecFileAsync`) with retry/WSL-routing, combining `gh issue/pr list --json` for fast listings, `gh api <rest-path>` for REST, and `gh api graphql -f query=...` for GraphQL. Authentication is entirely delegated to the `gh` CLI (keyring or `GITHUB_TOKEN`/`GH_TOKEN`); Orca does not manage its own tokens, it only diagnoses auth state (`gh auth status`, parsed in `auth-diagnose.ts`).

Naming/layout conventions observed and worth preserving for any new work:

- `src/main/github/*` — network/gh-CLI logic
- `src/shared/*github*` — cross-process (main/preload/renderer) type contracts
- `src/renderer/src/components/github-project/*` — Projects UI (PascalCase components, kebab-case pure logic with co-located `.test.ts`)
- IPC handlers centralized in `src/main/ipc/github.ts`, typed contract in `src/preload/api-types.ts` under `window.api.gh.*`

### 6.2 What already exists for ProjectsV2

- `src/shared/github-project-types.ts` already defines `GitHubProjectFieldDataType` including `PARENT_ISSUE`, `SUB_ISSUES_PROGRESS`, `TRACKS`, `TRACKED_BY`, and `ISSUE_TYPE`, alongside the standard field types.
- `src/main/github/project-view.ts` implements a full GraphQL read path: project/view discovery, field-config fetch (`FIELD_CONFIG_FRAGMENT`), paginated item fetch, and normalization (`normalizeField`, `normalizeFieldValue`, `normalizeItem`).
- `itemContentSelection(includeParent)` already conditionally requests `parent { number title url }` on `Issue`, with a documented retry ("parent field dance") that drops the `parent` selection and retries when the token/owner lacks the needed capability, tracked per-owner in module-scope caches (`parentFieldRetriedByOwner`, etc.).
- `src/renderer/src/components/github-project/ProjectCell.tsx` already has a dispatch branch for `field.dataType === 'PARENT_ISSUE'`, rendering `#<number>` from `row.content.parentIssue`.

This means **parent-link support is already partially viable today** — Orca already fetches it conditionally and already renders a minimal representation.

### 6.3 Concrete gaps (the actual delta this RFC is scoping)

1. **GraphQL field-value selection gap.** `FIELD_VALUES_SELECTION` in `project-view.ts` requests inline fragments only for `ProjectV2ItemFieldSingleSelectValue`, `...IterationValue`, `...TextValue`, `...NumberValue`, `...DateValue`, `...LabelValue`, `...UserValue`. It does not request the value shapes needed to hydrate `SUB_ISSUES_PROGRESS`, `TRACKS`, or `TRACKED_BY` as Project field values.
2. **Silent-drop normalization risk.** `normalizeFieldValue()` has an explicit `default: return null` branch for any unrecognized `__typename`, documented in code as intentional forward-compatibility (avoid throwing/drift-classifying on unknown shapes). This is safe for stability but means that even after fetching hierarchy/progress field values, an unmapped `__typename` would silently vanish rather than surface as a visible gap — a real risk if GitHub's field-value union has more members (verified: 11 concrete types) than Orca's current `GitHubProjectFieldValue` union covers.
3. **No dedicated renderers.** `ProjectCell.tsx` has no dispatch branch for `SUB_ISSUES_PROGRESS`, `TRACKS`, or `TRACKED_BY`; a value that doesn't match a known `kind` falls through to an empty `<span />`.
4. **Table-only rendering.** `ProjectViewWrapper.tsx` and `project-view.ts` explicitly detect and message `unsupported_layout` for `BOARD_LAYOUT` and `ROADMAP_LAYOUT`; only `TABLE_LAYOUT` renders. `ProjectPicker.tsx` labels Board as "(unsupported)" in the UI today.
5. **Flat row model.** `ProjectRow.tsx` renders one flat grid row per item; `src/shared/github-project-group-sort.ts` groups/sorts on flat field values only (string/number/date/single-select/iteration/labels/users). There is no tree/indentation/expand-collapse concept, so even with hierarchy data available, today's row model cannot render an indented epic→story→task structure without new code.
6. **Issue-level hierarchy reads are not integrated.** Orca's Project GraphQL selection reads `Issue.parent` but does not read `Issue.subIssues`/`subIssuesSummary`/`trackedIssues`/`trackedInIssues`; those live on the Issue domain, not the Project domain, and are not currently touched by `project-view.ts` or `work-item-details.ts`.
7. **No mutation for hierarchy.** Orca has no code path that calls the REST sub-issues endpoints (add/remove/reorder) or issue-level GraphQL mutations (`addSubIssue`/`removeSubIssue`/`reprioritizeSubIssue`).

## 7. Technical options

### Option A — Rely purely on ProjectV2 field values (Project-scoped)

Fetch `PARENT_ISSUE`, `SUB_ISSUES_PROGRESS`, `TRACKS`, `TRACKED_BY` as Project field values in the same GraphQL query Orca already issues for table rows.

- **Pros:** single round trip, reuses Orca's existing paginated items query, no new IPC surface, aligns with the "GitHub already computes this for me" principle.
- **Cons:** only surfaces what's visible in the *current Project's configured fields*; doesn't give Orca a way to read hierarchy for issues not shown as a field, or to do a full recursive epic-tree fetch on demand (e.g., in a drawer/detail view).
- **Best for:** Phase 1 (table column parity).

### Option B — Issue-level GraphQL hierarchy reads (Issue-scoped)

Query `Issue.parent`, `subIssues`, `subIssuesSummary`, `trackedIssues`/`trackedInIssues` directly, either alongside existing work-item detail fetches (`work-item-details.ts`) or via a dedicated hierarchy-fetch function in `project-view.ts` / a new sibling module.

- **Pros:** authoritative source of hierarchy; works independent of whether a Project even has the field enabled; supports deep/recursive fetch with the manual-nesting pattern described in §5.2.
- **Cons:** a second query shape to maintain; additional GraphQL rate-limit spend; needs its own caching/pagination story for wide epics (up to 100 children) or deep trees (up to 8 levels).
- **Best for:** Phase 2 (recursive roll-up, hierarchy navigation, work-item drawer enrichment).

### Option C — REST sub-issues for mutation/ordering

Use REST endpoints for add/remove/reorder sub-issue operations, following the same pattern as Orca's existing REST-backed mutation helpers in `project-view/mutations.ts`.

- **Pros:** simplest mutation surface, well-documented, matches Orca's existing REST usage patterns and rate-limit bucket model (`rateLimitGuard('core')`).
- **Cons:** mutation-only; still needs Option A/B for reads.
- **Best for:** any phase that adds write support for hierarchy.

### Option D — New tree/roadmap row model

Build a genuinely hierarchical row/view model (indentation, expand/collapse, and/or a timeline-style roadmap) as a new rendering mode alongside (not replacing) the existing flat table.

- **Pros:** closest to "similar to the example panel" as a visual/UX outcome.
- **Cons:** materially larger scope — new data shape (tree, not flat rows), new sort/group algorithm, new interaction model, likely new IPC calls for lazy-loading deeper levels, and product decisions (how deep to auto-expand, how to handle cross-repo parents, how to blend with existing filters/sorts). This is a new feature, not an extension of `ProjectRow`/`github-project-group-sort.ts`.
- **Best for:** Phase 3, and only after Phase 1/2 validate real user demand.

### Recommendation

Combine **A + C** for Phase 1, add **B (+ C for writes)** for Phase 2, and treat **D** as a distinct, separately-scoped Phase 3 initiative requiring its own design review before commitment.

## 8. Proposed phased design

### Phase 1 — Traceability in the existing table (recommended starting point)

**Scope:** make Parent issue, Sub-issue progress, Tracks, and Tracked-by visible and correct as read-only table columns, reusing 100% of Orca's existing Project table rendering pipeline.

**Changes:**

1. `src/shared/github-project-types.ts`: extend `GitHubProjectFieldValue` with new variants for hierarchy/progress values (e.g. `{ kind: 'sub-issues-progress'; fieldId: string; total: number; completed: number; percentCompleted: number }`, `{ kind: 'issue-ref-list'; fieldId: string; issues: GitHubProjectParentIssue[] }` for Tracks/Tracked-by).
2. `src/main/github/project-view.ts`: extend `FIELD_VALUES_SELECTION` with inline fragments for the corresponding `ProjectV2ItemFieldValue` union members (subject to the exact typenames being confirmed in a short implementation spike against a live query, since the field-value union's hierarchy-specific member names were not verbatim-read from the SDL body in this session — see §5.2 caveat). Extend `normalizeFieldValue()` to map them instead of falling into the silent-drop branch.
3. `src/renderer/src/components/github-project/ProjectCell.tsx`: add dispatch branches for the new `dataType`s, rendering a simple progress pill/percentage for `SUB_ISSUES_PROGRESS` and a compact issue-chip list for `TRACKS`/`TRACKED_BY`, consistent with the existing `PARENT_ISSUE` `#<number>` treatment.
4. No IPC contract changes beyond the shared type extension (the existing `GetProjectViewTableResult` payload already carries `fieldValuesByFieldId`).
5. Tests: extend `project-view.test.ts` normalizer tests and `ProjectCell` render tests (co-located pattern already used in this module).

**Effort:** low-medium (1 shared-type change, 1 GraphQL fragment extension, 1 normalizer extension, 1–2 new cell renderers, tests). Fits within Orca's existing file/test conventions with no new modules required.

**Risk:** low-medium. Main risks are (a) confirming exact GraphQL union member names for these field values in a spike before committing to the fragment, and (b) verifying whether the "parent field dance" retry pattern needs to be generalized to cover these new selections too (i.e., do they fail the same way for tokens without the right scope?).

### Phase 2 — Hierarchy-aware interactions

**Scope:** go beyond "what's visible as a Project field" to authoritative Issue-level hierarchy: recursive roll-up beyond one level, hierarchy-aware detail view (e.g., in `GitHubItemDialog.tsx`), and write support (add/remove/reorder sub-issues).

> **Status update (2026-07-15): shipped.** Implemented as designed, with one correction to point 3 below — the RFC anticipated REST for writes, but a live spike found `addSubIssue`/`removeSubIssue`/`reprioritizeSubIssue` are GraphQL mutations, which is what shipped (simpler, one round trip, reuses the existing `runGraphql` plumbing instead of adding a REST path). See `docs/reference/2026-07-15-github-projects-hierarchy-phase2-plan.md` for the execution plan and the Phase 2 GitHub issue report for evidence.

**Changes:**

1. New read path (likely a sibling module to `project-view.ts`, following the existing `src/main/github/project-view/{internals,mutations}.ts` split pattern) issuing the Issue-level GraphQL query from §5.2, with the fixed-depth-then-lazy-load pattern for trees deeper than 2–3 levels.
2. Client-side recursive aggregation utility (pure function, likely in `src/shared/`) to compute a whole-tree percentage when needed, since GitHub does not provide that natively.
3. Write support via REST (`project-view/mutations.ts` pattern) for add/remove/reorder, respecting the 100-child/8-level hard limits with client-side validation before calling the API (to avoid opaque 422s).
4. Rate-limit and caching considerations: hierarchy reads are Issue-scoped, so they should be integrated with Orca's existing `rateLimitGuard('graphql')` circuit breaker and ideally batched with existing work-item detail fetches rather than issued as a separate round trip per row.

**Effort:** medium-high. New query surface, new aggregation logic, new mutation surface, plus UX decisions (where does "expand to see full hierarchy" live if the table stays flat?).

**Risk:** medium. Main risks are rate-limit spend on wide/deep trees (mitigated by lazy-loading), and the GraphQL 10-second timeout on large projects (mitigated by the existing pattern of shrinking page sizes).

### Phase 3 — True nested/roadmap visualization

**Scope:** a genuinely hierarchical view — indentation/expand-collapse tree and/or a roadmap-style timeline — as a new view mode.

**Effort:** high. Requires a new row/view data model (not a flat array), a new grouping/ordering algorithm that understands parent-child structure (extending or replacing `github-project-group-sort.ts`), new interaction patterns (expand/collapse state, lazy loading of children), and product decisions about depth limits, cross-repo parents, and how this new view composes with existing filters/sorts/columns.

**Risk:** higher, and largely product-scope risk rather than pure API risk: GitHub's own Roadmap view has limited API-manageable configuration (view layout mutations are not fully exposed), so a "similar to GitHub's roadmap" visual outcome would be a bespoke Orca UI built on top of Phase 1/2 data, not a thin wrapper over a GitHub-provided view.

**Recommendation:** treat as a separate RFC/design pass, gated on validated user demand after Phase 1 ships.

## 9. Risks

| # | Risk | Phase | Mitigation |
|---|---|---|---|
| 1 | Silent schema drift: unknown `__typename`s are dropped by design in `normalizeFieldValue`, so new/changed GitHub field-value shapes could go invisible without error | 1+ | Extend the union deliberately per §8.1; consider adding non-fatal telemetry/logging when an unmapped `__typename` is seen, without breaking the existing crash-resistance guarantee |
| 2 | Unverified exact GraphQL field-value typenames for `SUB_ISSUES_PROGRESS`/`TRACKS`/`TRACKED_BY` at the `ProjectV2ItemFieldValue` union level | 1 | Short implementation spike: run a live `gh api graphql` query against a real Project with these fields enabled before finalizing the fragment |
| 3 | Auth/scope gaps: fine-grained PAT and GitHub Apps cannot read user-owned Projects (official GitHub limitation); Orca already handles this class of failure via `scope_missing`/`auth_required` classification | 1+ | Reuse existing `classifyProjectError`/`auth-diagnose.ts` patterns; no new gap introduced, but user-owned Projects should be explicitly tested |
| 4 | GraphQL 10s timeout / 502-504 on large projects when adding more nested fragments or recursive queries | 2 | Reuse Orca's existing page-size-shrinking mitigation; keep hierarchy reads lazy/paginated rather than eagerly nested to max depth |
| 5 | No Project webhooks for user/repo-owned projects — no push-based sync path regardless of design | 1+ | Continue Orca's existing pull/refresh model; do not design around webhook availability |
| 6 | Hard GitHub limits (100 children/issue, 8 levels deep, one parent per issue) not enforced client-side before mutation calls | 2 | Validate against these limits before issuing REST add/reorder calls to avoid opaque 422s |
| 7 | Scope creep from "traceability" into "full Projects UI clone" | 3 | Explicit phase gating in this RFC; Phase 3 requires its own design review |
| 8 | Flat-row assumption baked into `github-project-group-sort.ts` and `ProjectRow.tsx` could be extended informally over time into an unreviewed ad-hoc tree model | 3 | Treat any tree/indentation work as requiring the Phase 3 design pass, not incremental patches to the flat-row modules |

## 10. Impact on current architecture

- **Shared contract (`src/shared/github-project-types.ts`):** additive changes only for Phase 1 (new `GitHubProjectFieldValue` variants); no breaking changes to existing consumers (main, preload, renderer all import from this single source of truth already).
- **Main process (`src/main/github/project-view.ts` and siblings):** Phase 1 extends existing fragments/normalizers in place; Phase 2 likely adds a new sibling module following the existing `project-view/{internals,mutations}.ts` split, keeping the "one file per concern" convention already established.
- **IPC / preload (`src/main/ipc/github.ts`, `src/preload/api-types.ts`):** no changes needed for Phase 1 (existing `getProjectViewTable` payload already carries per-field values); Phase 2 likely needs a new typed IPC method for on-demand hierarchy fetch (e.g., `getIssueHierarchy`), following the existing typed-args/typed-result pattern used throughout this module.
- **Renderer (`src/renderer/src/components/github-project/*`):** Phase 1 is additive to `ProjectCell.tsx` only; Phase 2 likely touches `GitHubItemDialog.tsx` for a hierarchy section; Phase 3 requires new components and a new row/view model, i.e., a genuinely new feature area under this same directory.
- **Auth/rate-limit model:** no change to the underlying model (still `gh` CLI, still `rateLimitGuard`/`noteRateLimitSpend` buckets); Phase 2 adds spend against the `graphql` bucket that should be accounted for in review.
- **No SDK migration implied.** Everything proposed fits within the existing `gh api graphql` / `gh api <rest-path>` shelling-out model; there is no architectural case made here for introducing Octokit or a different GitHub client.

## 11. Effort and viability summary

| Phase | Effort | Risk | Viability | Primary value delivered |
|---|---|---|---|---|
| 1 — Table traceability | Low-medium | Low-medium | **High — recommended to start immediately** | Parent/progress/tracking visible and correct in the table Orca already ships |
| 2 — Hierarchy-aware interactions | Medium-high | Medium | Medium — recommended after Phase 1 validates usage | Recursive roll-up, hierarchy navigation, write support |
| 3 — Nested/roadmap visualization | High | Medium-high (mostly product-scope risk) | Conditional — needs its own RFC/design review | Visual parity with "similar to the example panel" |

## 12. Open questions for reviewers

1. Should Phase 1 ship hierarchy/progress as **read-only** columns initially, deferring any inline-edit affordance (consistent with how `PARENT_ISSUE` is already read-only today)?
2. For Phase 2, should the hierarchy fetch be triggered eagerly for every visible row (rate-limit cost) or lazily on row expand/drawer open?
3. Does Orca need to support GitHub Enterprise Server for this feature, given sub-issues' relatively recent GA and potential GHES version lag? This should be confirmed before Phase 2 scoping.
4. Should Phase 3 be scoped as a new "Roadmap" view mode reusing the existing `ROADMAP_LAYOUT` detection already present in `ProjectViewWrapper.tsx`/`ProjectPicker.tsx` (currently marked unsupported), or as an entirely Orca-native visualization independent of GitHub's own view-layout concept?

## Sources

- GitHub REST API — sub-issues: https://docs.github.com/en/rest/issues/sub-issues
- GitHub GraphQL API reference (index): https://docs.github.com/en/graphql/reference
- GitHub public GraphQL schema SDL (verified directly, `Issue` object `parent`/`subIssues`/`subIssuesSummary`/`trackedIssues`/`trackedInIssues`/`trackedIssuesCount`): https://docs.github.com/public/fpt/schema.docs.graphql
- GitHub GraphQL reference — Projects (ProjectV2, ProjectV2Item, ProjectV2ItemFieldValue, ProjectV2FieldType): https://docs.github.com/en/graphql/reference/projects
- Using the API to manage Projects (official guide): https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects
- GraphQL pagination guide: https://docs.github.com/en/graphql/guides/using-pagination-in-the-graphql-api
- GraphQL rate limits: https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api
- Webhook events and payloads (`projects_v2`, `projects_v2_item`, `projects_v2_status_update`): https://docs.github.com/en/webhooks/webhook-events-and-payloads
- Adding sub-issues (limits: 8 levels, 100 children, single parent): https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues
- Parent issue / Sub-issue progress Project fields: https://docs.github.com/en/issues/planning-and-tracking-with-projects/understanding-fields/about-parent-issue-and-sub-issue-progress-fields
- About tasklists (tasklist-block retirement, tracked-by legacy mechanism): https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/about-tasklists
- Sub-issues engineering blog (data model, rollup table): https://github.blog/engineering/architecture-optimization/introducing-sub-issues-enhancing-issue-management-on-github/
- Sub-issues/Issue Types/Advanced Search GA announcement (2025-04-09): https://github.blog/changelog/2025-04-09-evolving-github-issues-and-projects/
- REST API for Projects + sub-issues improvements (2025-09-11: cross-org, parent-inherits-Project, `GET .../parent`): https://github.blog/changelog/2025-09-11-a-rest-api-for-github-projects-sub-issues-improvements-and-more/
- First REST API for sub-issues (2024-12-12): https://github.blog/changelog/2024-12-12-github-issues-projects-close-issue-as-a-duplicate-rest-api-for-sub-issues-and-more/
- Community discussion — sub-issues beta announcement, real GraphQL examples, 8-level/100-child limits: https://github.com/orgs/community/discussions/139932
- Community discussion — confirmation of no plans to raise the 100-child limit: https://github.com/orgs/community/discussions/154148
- Fine-grained PAT limitations (no user-Project access): https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
- GitHub App permissions (org-level "Projects" permission): https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app
- Example panel referenced by the user (inaccessible during this investigation — HTTP 404): https://github.com/orgs/CodigoSinSiesta/projects/1/views/1

**Orca source files inspected directly during this investigation:** `src/shared/github-project-types.ts`, `src/main/github/project-view.ts`, `src/main/github/project-view/internals.ts`, `src/main/github/project-view/mutations.ts`, `src/main/github/auth-diagnose.ts`, `src/main/github/work-item-details.ts`, `src/renderer/src/components/github-project/ProjectCell.tsx`, `src/renderer/src/components/github-project/ProjectRow.tsx`, `src/renderer/src/components/github-project/ProjectViewWrapper.tsx`, `src/renderer/src/components/github-project/columns.ts`, `src/shared/github-project-group-sort.ts`.
