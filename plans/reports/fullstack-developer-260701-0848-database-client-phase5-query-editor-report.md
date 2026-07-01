# Database Client Phase 5 — Query Editor & Results Grid

Date: 2026-07-01
Branch: feat/database-client
Scope: Monaco SQL editor, DB-enforced read-only, cursor-bounded results,
server-side cancel, destructive-write confirm. Final phase of the plan.

## Delivered

### Shared
- `database-types.ts` — `QueryColumn`/`QueryResult`/`QueryOptions`/`QueryHandle`/
  `DbQueryResult`.
- `sql-statement-classifier.ts` (pure, cross-process) — `isCursorableRead`
  (cursor path selection) + `needsWriteConfirm` (confirm-dialog gate). Comments
  and string literals are blanked so keywords/`;` inside literals don't misfire.
  **Not a security boundary.**

### Main process
- `db-driver.ts` — `query`/`cancel` on `DbDriver`; `config` added to
  `LiveConnection` (so cancel can open a side connection); `DB_MAX_ROWS=1000`,
  `DB_STATEMENT_TIMEOUT_MS=30000`.
- `postgres-query.ts` — read in `BEGIN` + `SET TRANSACTION READ ONLY`;
  `statement_timeout`; **DECLARE CURSOR / FETCH FORWARD rowLimit+1** (no
  `pg-cursor` dep, no LIMIT rewrite); writes run direct; `pg_cancel_backend`
  from a short-lived `pg.Client`.
- `mysql-query.ts` — `START TRANSACTION READ ONLY`; `max_execution_time`;
  **row-by-row stream (`rowsAsArray`) bounded to rowLimit+1**; a truncated
  stream poisons the pooled connection → destroyed, not released; `KILL QUERY`
  from a short-lived connection.
- drivers wire the above; `db-connection-manager.ts` tracks the in-flight
  `QueryHandle` per connection for cancel.
- `ipc/database.ts` — `database:query` (**`allowWrite` derived from stored
  `readOnly` server-side; renderer value ignored; missing connection → read-only**)
  + `database:cancelQuery`; both trusted-gated; results returned redacted.

### Renderer
- `monaco-sql-language.ts` — lazy-register the SQL basic-language (red-team F13).
- `QueryEditor.tsx` (Monaco SQL, Cmd/Ctrl+Enter via KeyMod.CtrlCmd) ·
  `ResultsGrid.tsx` (virtualized, NULL vs empty, copy-cell, truncated badge) ·
  `QueryWorkspace.tsx` (Run/Cancel, read-only badge, destructive-write confirm
  dialog for writable connections).
- store slice: `dbQueryText` + `dbQueryState` + run/cancel; cleared on
  disconnect/lost/remove. `DatabasePage` now list → schema tree → workspace.
- i18n: 15 keys × 5 catalogs (parity preserved).

## Red-team findings addressed
F3 (read-only at the DB, not keywords; `allowWrite` server-derived; confirm
dialog as the writable-default guard) ✓ · F9 (cursor/stream bounded rowLimit+1,
no LIMIT append) ✓ · F4/F10 (real server-side cancel via side connection +
captured PID/thread-id) ✓ · F13 (Monaco SQL registered) ✓.

## Verification
- Unit tests **220 passed** (+54 Phase 5): classifier (reads/writes/CTE/
  multi-statement/string-literal), pg query (read-only txn issued, cursor
  rowLimit+1 + truncated, SQL embedded verbatim/no LIMIT, rollback, cancel), mysql
  query (read-only txn, streaming bound + poisoned-conn destroy, direct write,
  KILL), manager query/cancel in-flight tracking, IPC allowWrite-from-readOnly
  (+ renderer value ignored + missing→read-only) + redacted error + trusted gate,
  Monaco SQL registration.
- `typecheck:node` ✓ · `typecheck:web` ✓ · `oxlint` ✓ · switch-exhaustiveness ✓
- localization catalog parity ✓ · coverage ✓

## Deferred / notes
- Live PG/MySQL integration tests (docker) remain the recommended follow-up —
  unit tests mock drivers, so real read-only-rejection, real cursor streaming,
  and real cancel are asserted at the SQL-issued level, not against a server.
- `QueryColumn.dataType` is populated as names-only (no OID/type-code → name map);
  headers render correctly, precise type labels are a display-only follow-up.
- MySQL streaming reaches the core connection via `.connection`; validated by
  unit mocks, wants an integration pass.

## Unresolved questions
None.

Status: DONE — all 5 phases complete.
