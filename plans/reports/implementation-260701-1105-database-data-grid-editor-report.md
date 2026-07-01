# Database Data Grid Editor — Implementation Report

Date: 2026-07-01
Branch: feat/database-client
Scope: DBeaver-style editable data grid on top of the existing DB client — sort by
column, filter by column, server-side pagination, and cell edit + insert + delete.
Plan: `~/.claude/plans/floating-prancing-duckling.md` (approved).

## Product decisions (user)
1. **Tabbed workspace** — permanent "Query" tab + one "Data" tab per opened table.
2. **Edit + insert + delete** — staged, applied atomically, keyed by primary key.
3. **Server-side re-query** for free-form Query-tab sort/filter (wraps the read).

## Delivered (4 phases, each independently shippable)

### Phase 1 — Shared builders + parameterized execute IPC (backend)
- `src/shared/sql-identifier.ts` — exported `quoteIdentifier` (moved from
  `table-preview-query.ts`) + `placeholder` (`$n` / `?`).
- `src/shared/table-data-sql.ts` — `buildSelectSql` / `buildCountSql` /
  `buildUpdateByKeySql` / `buildInsertSql` / `buildDeleteByKeySql` /
  `buildWrappedQuerySql`; each returns `{ sql, params }`. Identifiers quote-escaped,
  every value a bind param, LIMIT/OFFSET app-controlled ints. Wrapped free-form sort
  is by ORDINAL (survives duplicate names); filter by name (disabled for dupes).
- `DbDriver.execute` + `executeBatch` (pg + mysql): one parameterized statement in a
  read-only/writable txn; batch = one atomic transaction, `ROLLBACK` + `DbBatchError`
  (`failedIndex`) on any failure.
- `database:execute` + `database:executeBatch` IPC — trusted-gated, `allowWrite`
  derived server-side from stored `readOnly`, errors redacted, batch surfaces
  `failedIndex`. Preload + api-types + web stub extended.

### Phase 2 — Tabbed workspace + read-only Table Data view (renderer)
- Store: `dbWorkspaceTabs` + `dbTableData` per connection→tab; `openDbTableTab`
  (repointed from `previewDbTable`), `closeDbTab`, `setActiveDbTab`,
  `loadDbTableData` (fetch pageSize+1 → `hasNext`, no COUNT), sort/filter/page/count
  actions. Purged on non-live + remove.
- `database-workspace-tabs.ts` (pure) — tab reducers. `data-grid-sort-state.ts`,
  `data-grid-filters.ts` (pure) — sort cycle + filter upsert.
- Components: `DatabaseWorkspace` (tab bar), `TableDataView` (toolbar + grid +
  pagination), `TableDataGrid` (virtualized), `DataGridColumnHeader` (tri-state sort +
  filter, **reused by Phase 4**), `data-grid-column-filter` (popover),
  `data-grid-cell-format.ts` (shared; `ResultsGrid` refactored onto it).

### Phase 3 — Cell edit + insert + delete (renderer)
- `table-data-edit-buffer.ts` (pure) — stage cell edits / new rows / deletes keyed by
  PK; dirty detection; `bufferToStatements` (DELETE → UPDATE → INSERT; keys read
  ORIGINAL row so editing a PK still targets the right row; skips update on a deleted
  row). Re-typed number strings don't stage no-op updates; NULL ≠ ''.
- `TableDataCellEditor` (Enter/Esc/blur + ∅ Set NULL), `TableDataCell` (double-click
  edit, dirty wash via `--annotation-highlight` color-mix), `TableDataRowMenu`
  (delete/restore/discard via `ui/context-menu`).
- Store edit actions + `saveDbEdits` (→ `executeBatch`, reload on success, keep buffer
  + `saveError` on failure). Editing gated on **PK present && writable**; no-PK /
  read-only → read-only badge. Navigation (sort/filter/page/refresh) locked while dirty
  to prevent silent edit loss.

### Phase 4 — Server-side sort/filter/paginate for the free-form Query tab
- Store: `DbQueryState.refine` armed only for `isCursorableRead` runs; `setDbQuerySort`
  (ordinal), `setDbQueryFilters`, `setDbQueryPage` → wrap current read via
  `buildWrappedQuerySql` and re-run through `database:execute`.
- `ResultsGrid` reuses `DataGridColumnHeader` + filter (disabled for duplicate names) +
  a pagination footer once engaged. `QueryWorkspace` wires the handlers.

## Verification
- Unit: **1757 pass** across the DB + store suite (new: builders per engine incl.
  identifier escaping / mutations / wrapped ordinal-sort; execute/executeBatch incl.
  txn rollback + `failedIndex` + allowWrite; IPC trusted/redaction/allowWrite; tab +
  sort + filter reducers; edit-buffer + save flow incl. no-PK refusal + error-keeps-
  buffer; query-refine arm/sort/page).
- `typecheck:node` ✓ · `typecheck:web` ✓ · `typecheck:cli` ✓ · switch-exhaustiveness ✓
  · styled-scrollbars ✓ · localization catalog parity ✓ · coverage ✓ (4 reviewed
  allowlist entries: SQL operator keywords LIKE/ILIKE/IS NULL/IS NOT NULL).

## Known limitations (v1, documented in plan)
- Concurrency: UPDATE/DELETE key on **PK only** (no optimistic all-column WHERE).
- No-PK tables + views/joins/expression columns are read-only; free-form results are
  editable only through a table Data tab, never the Query tab.
- Total row count is lazy/on-demand; next/prev uses limit+1 detection.
- Filter/edit values pass as strings; DB casts by column type (light).
- Navigation while dirty is locked (edits kept) rather than a modal confirm.

## Not run
- Base `oxlint` gate: environment has oxlint **1.67.0**, repo pins **^1.71.0**; oxlint
  fails at config-parse on `unicorn/no-array-fill-with-reference-type` (a 1.71 rule)
  before linting any file — pre-existing, unrelated to this change. Fix: `pnpm install`
  to the pinned version, then `pnpm oxlint`.
- Live PG/MySQL integration (docker): unit tests mock drivers; real read-only rejection,
  cursor/stream bounds, and executeBatch atomicity assert at the SQL-issued level.

## Unresolved questions
None blocking.
