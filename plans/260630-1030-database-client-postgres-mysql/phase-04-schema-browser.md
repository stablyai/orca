---
phase: 4
title: "Schema Browser"
status: done
effort: "M"
---

# Phase 4: Schema Browser

## Overview

Read structure from a live connection and render it as a navigable tree:
connection → databases/schemas → tables/views → columns. Introspection is **lazy
per level and capped** so a server with tens of thousands of objects can't freeze
the app, and it runs on the **dedicated introspection connection** so it never
contends with a running query.

## Requirements

- Functional: expand a connected DB to see schemas/tables/views; expand a table to
  see columns and types; refresh re-introspects.
- Non-functional: introspection runs in the main process on the introspection
  connection (not the query connection); each level lazy + row-capped; tree virtualized.

## Architecture

`DbDriver.introspect` returns a normalized `DbSchemaTree`, hiding engine differences
(Postgres schemas under a database via `information_schema`/`pg_catalog`; MySQL
databases-as-schemas via `information_schema`). The renderer tree is virtualized with
`@tanstack/react-virtual` (already used: `useVirtualizer`).

**Red-team F9 (cap introspection):** never enumerate all tables across all schemas in
one buffered query — that result is buffered in main and structured-cloned to the
renderer (same freeze/OOM class as the query path). Fetch lazily per database/schema,
cap rows (e.g. `maxObjects + 1` to detect overflow), and surface a "too many objects —
filter" state instead of buffering everything. Columns load only when a table expands.

**Red-team F11 (no contention):** introspection uses the dedicated introspection
connection from Phase 3's manager, so expanding the tree while a long query runs does
not block, and cancelling a query (destroy) does not orphan an in-flight introspection.

```ts
// src/shared/database-types.ts (additions)
export type DbColumn = { name: string; dataType: string; nullable: boolean; isPrimaryKey: boolean }
export type DbTable  = { name: string; kind: 'table' | 'view'; columns?: DbColumn[] }
export type DbSchemaNode = { name: string; tables: DbTable[]; truncated: boolean }
export type DbSchemaTree = { databases: { name: string; schemas: DbSchemaNode[] }[]; truncated: boolean }
```

## Related Code Files

- Modify: `src/shared/database-types.ts` — add `DbColumn`/`DbTable`/`DbSchemaTree`
  (with `truncated` flags).
- Modify: `src/main/database/postgres-driver.ts` — `introspect` via
  `information_schema.tables`/`columns` + `pg_catalog` for PK; schema-aware; capped.
- Modify: `src/main/database/mysql-driver.ts` — `introspect` via `information_schema`; capped.
- Create: `src/main/database/postgres-introspection-queries.ts`,
  `mysql-introspection-queries.ts` — named query builders (not a generic `utils` file).
- Modify: `src/main/ipc/database.ts` — `database:introspect` (lazy, capped) +
  `database:introspectTableColumns` (on table expand); trusted-sender gated.
- Modify: `src/preload/index.ts` — add introspect methods.
- Modify: `src/renderer/src/store/slices/database.ts` — per-connection schema cache +
  expand/refresh actions + overflow state.
- Create: `src/renderer/src/components/database/SchemaTree.tsx` — virtualized,
  keyboard-navigable; lazy expansion; "too many objects" affordance.

## Implementation Steps

1. Add schema types (incl. `truncated`).
2. Implement engine-specific, **capped, lazy** introspection query builders.
3. Wire `database:introspect` + `introspectTableColumns` IPC (on the introspection
   connection) + preload + slice cache.
4. Build `SchemaTree` with lazy expansion (DB → schema → table → columns) + overflow UI.
5. Add refresh; surface introspection errors inline (normalized, no credential leak).
6. Tests: query builders produce expected SQL per engine; cap/overflow sets `truncated`;
   tree normalization maps rows → `DbSchemaTree`; lazy column fetch triggers once;
   introspect uses the introspection connection, not the query connection.

## Success Criteria

- [ ] Connect → expand → see databases/schemas → tables/views → columns with types.
- [ ] Postgres multi-schema and MySQL single-schema both render correctly.
- [ ] A catalog with tens of thousands of objects does NOT freeze on connect — levels
      lazy + capped, overflow surfaced (red-team F9).
- [ ] Expanding the tree while a long query runs is not blocked (red-team F11).
- [ ] Refresh re-introspects; errors surfaced without crashing the tree.
- [ ] Typecheck + lint + unit tests green.

## Risk Assessment

- Engine quirks (Postgres `search_path`, MySQL case sensitivity) — keep query builders
  engine-specific and tested, not a lowest-common-denominator merge.
- Cap thresholds need sane defaults; expose the overflow state clearly so users filter.

## Red Team Hardening (applied)

- **F9 (High→Medium for introspect):** capped, lazy per-level introspection with a
  `truncated`/overflow state; never buffer the whole catalog.
- **F11 (High):** introspection runs on the dedicated introspection connection (no
  contention with queries; cancel-by-destroy can't orphan it).
