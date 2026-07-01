# Database Client Phase 4 — Schema Browser

Date: 2026-07-01
Branch: feat/database-client
Scope: lazy, capped introspection (schemas → tables → columns) on the live
connection, IPC + store cache, and a virtualized schema tree.

## Design decision (deviation from plan sketch)
Collapsed the plan's `databases[].schemas[].tables[]` nesting into a **unified
schema model**: connection → schemas → tables → columns. Postgres schemas are
namespaces in the connected DB; MySQL databases map onto this same schema level.
Rationale: engine-uniform tree, genuinely lazy per level, and each level caps
with a plain `LIMIT` (no window functions → MySQL 5.7 compatible). Added a third
IPC method (`introspectSchemaTables`) the sketch didn't list — required for true
per-schema laziness (F9).

## Delivered

### Main process
- `db-driver.ts` — `DbDriver` gains `introspectSchemas/introspectTables/
  introspectColumns`; `applyCap` helper (query cap+1 → `truncated`); caps
  `DB_MAX_SCHEMAS=500`, `DB_MAX_TABLES_PER_SCHEMA=2000`; `not_connected` safe error.
- `postgres-introspection-queries.ts` / `mysql-introspection-queries.ts` — named,
  pure SQL + row mappers (snake_case aliases → camelCase types); system schemas
  excluded; PK via `table_constraints`/`key_column_usage` (PG) and `column_key`
  (MySQL); `LIMIT $n` / `LIMIT ?`.
- `postgres-driver.ts` / `mysql-driver.ts` — implement the three methods on a
  pooled connection (F11: separate from the query connection).
- `db-connection-manager.ts` — `introspect*` methods; `requireLive` throws
  `db_not_connected` (async → rejection).
- `ipc/database.ts` — `database:introspect` / `:introspectSchemaTables` /
  `:introspectTableColumns`, trusted-gated, results returned redacted (never raw).

### Renderer / bridge
- Preload + api-types + web stub: three introspect methods.
- Store slice: per-connection `dbSchemaCache` (schemas / tables-by-schema /
  columns-by-table), `activeDbConnectionId`, lazy `loadDbSchemas/…SchemaTables/
  …TableColumns` (return results for inline error handling), cache dropped on
  disconnect / lost / remove.
- `schema-tree-rows.ts` — pure flattener → virtualizable rows (loading/error/
  empty/overflow markers). `SchemaTree.tsx` — `@tanstack/react-virtual`, lazy
  expand, keyboard nav (↑↓ move, →/← expand/collapse, Enter toggle), refresh,
  inline errors, overflow affordance.
- `DatabasePage` two-pane (list + tree for the active connection);
  `ConnectionList` rows select the active connection when connected.
- i18n: 12 keys × 5 catalogs (parity preserved).

## Red-team findings addressed
F9 (cap introspection) ✓ — every level `LIMIT cap+1`, `truncated` surfaced, columns
lazy; catalog never fully buffered. F11 (no contention) ✓ — introspection runs on a
pooled connection distinct from the query connection.

## Verification
- Unit tests **166 passed** (+33 Phase 4): query-builder SQL per engine, row
  mappers, `applyCap` overflow, manager `not_connected` + delegation, driver
  introspect mapping/truncation, IPC introspect ok/redacted-error/trusted-gate,
  and `buildSchemaRows` flattening (collapse/expand/loading/error/empty/overflow).
- `typecheck:node` ✓ · `typecheck:web` ✓ · `oxlint` ✓ · switch-exhaustiveness ✓
- localization catalog parity ✓ · coverage ✓

## Deferred / notes
- Live PG/MySQL integration test (docker) still an optional gated follow-up.
- Column list itself is uncapped (a single table's columns are bounded in
  practice); schemas + tables are capped.
- Phase 5 (query editor + results grid, read-only txn, server-side cancel) not started.

## Unresolved questions
None.

Status: DONE
