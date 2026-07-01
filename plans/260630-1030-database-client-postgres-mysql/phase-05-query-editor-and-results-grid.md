---
phase: 5
title: "Query Editor and Results Grid"
status: done
effort: "L"
---

# Phase 5: Query Editor and Results Grid

<!-- Updated: Validation Session 1 - readOnly default writable → confirm dialog is the primary write safety net -->

## Overview

The query workflow: a Monaco SQL editor (**with SQL highlighting actually
registered**), a `query` IPC that runs SQL with **database-enforced read-only**, a
**bounded cursor** so huge results can't freeze the app, and **real cancellation**.
The keyword classifier is a UX hint only — the security boundary is the database.

## Requirements

- Functional: type SQL → run → rows in a grid with headers; cancel a running query
  (server-side); errors shown inline. Read-only connection rejects writes at the DB.
- Non-functional: results bounded by a server-side cursor (not buffered whole), grid
  virtualized; query runs in main with statement timeout; cancel frees the server query.

## Architecture

Monaco is api-only in Orca — basic-languages are opt-in (`MonacoCodeExcerpt.tsx:15`
registers Python by hand). **Red-team F13:** register
`monaco-editor/esm/vs/basic-languages/sql/sql.js` (or pgsql/mysql) before mounting,
or the editor silently renders plaintext.

**Read-only enforcement (red-team F3, Critical):** the leading-keyword classifier is
defeated by `SELECT 1; DROP TABLE x` (pg simple-query runs multi-statement) and
writing CTEs. Enforce at the engine, not by string match:
- Postgres: run reads in `BEGIN TRANSACTION READ ONLY` (or a session with
  `default_transaction_read_only=on`); the DB rejects writes.
- MySQL: `START TRANSACTION READ ONLY`; keep `multipleStatements:false` (the default).
- The keyword classifier only drives the **confirm dialog UX** for writable
  connections; it is never the security boundary. `allowWrite` derives from the
  connection's `readOnly` flag server-side; missing `readOnly` is treated as **writable**
  (validated default), so the **confirm dialog below is the primary write safety net**
  for the default (writable) connection — read-only is opt-in but DB-enforced when set.

**Result transport (red-team F9, High):** `pg.Client.query` buffers the entire result;
a single `invoke` then structured-clones it on the main thread → freeze/OOM. Use a
server-side bounded cursor (pg `Cursor`/portal `maxRows`, mysql2 `query().stream()`),
fetch at most `rowLimit + 1` rows, set `truncated` from the `+1` probe. Never append a
SQL `LIMIT` (breaks on existing `LIMIT`/trailing `;`/multi-statement). If even the
capped clone is large, marshal in chunks / consider a worker.

**Cancellation (red-team F4/F10, High):** an `AbortController` token does NOT abort a
running pg/mysql query (server keeps executing, holding the connection). Capture the
backend PID/thread-id at query start; cancel via a short-lived **second** connection
(`pg_cancel_backend(pid)` / `KILL QUERY id`) or `connection.destroy()`. Pooled
`pool.query` can't be cancelled mid-flight — run cancellable queries on a dedicated
query connection from the manager (Phase 3 F11).

```ts
// src/shared/database-types.ts (additions)
export type QueryColumn = { name: string; dataType?: string }
export type QueryResult = { columns: QueryColumn[]; rows: unknown[][]; rowCount: number; truncated: boolean; durationMs: number }
export type QueryOptions = { rowLimit: number; timeoutMs: number; allowWrite: boolean }
export type QueryHandle = { connectionId: string; backendPid: number | null }
```

## Related Code Files

- Modify: `src/shared/database-types.ts` — add `QueryColumn`/`QueryResult`/`QueryOptions`/`QueryHandle`.
- Modify: `src/main/database/{postgres,mysql}-driver.ts` — `query` (read-only txn when
  `!allowWrite`; statement timeout; **cursor** bounded to `rowLimit+1`; capture
  backendPid) + `cancel` (separate connection).
- Modify: `src/main/database/db-connection-manager.ts` — track in-flight query +
  backendPid per connection; provide a cancel connection.
- Modify: `src/main/ipc/database.ts` — `database:query` + `database:cancelQuery`;
  derive `allowWrite` from the connection's `readOnly` **server-side** (don't trust
  the renderer); trusted-sender gated.
- Modify: `src/preload/index.ts` — add query/cancel methods.
- Modify: `src/renderer/src/store/slices/database.ts` — editor text, running state,
  result, error.
- Create: `src/renderer/src/lib/monaco-sql-language.ts` — register the SQL
  basic-language (mirror `MonacoCodeExcerpt.tsx` registration).
- Create: `src/renderer/src/components/database/QueryEditor.tsx` (Monaco sql, Run/Cancel,
  Cmd/Ctrl+Enter platform-correct) and `ResultsGrid.tsx` (virtualized; NULL/empty render;
  copy cell; `truncated` indicator).

## Implementation Steps

1. Add query types/handle. (`readOnly` already on the model from Phase 2.)
2. Register the Monaco SQL language (`monaco-sql-language.ts`).
3. Implement `query` in both drivers: wrap reads in a DB read-only transaction when
   `!allowWrite`; statement timeout; cursor → `rowLimit+1`; capture backendPid.
4. Implement `cancel` via a separate connection (`pg_cancel_backend`/`KILL QUERY`/destroy).
5. Add `database:query`/`cancelQuery` IPC; derive `allowWrite` from `readOnly`
   server-side; keyword classifier only for the writable-connection confirm dialog.
6. Preload + slice wiring; build `QueryEditor` + `ResultsGrid`.
7. Confirm dialog on classified-write when writes allowed; DB rejects writes when read-only.
8. Tests: read-only connection — DB rejects `SELECT 1; DROP TABLE x` and a writing CTE
   (not a keyword check); cursor caps at `rowLimit+1` and sets `truncated`; never appends
   `LIMIT`; cancel issues a real server-side cancel (mock the cancel connection); SQL
   language registered; `allowWrite` ignored when sent by renderer (server uses `readOnly`).

## Success Criteria

- [ ] Run a `SELECT` → virtualized grid, correct headers/types; `truncated` past cap.
- [ ] Read-only connection (opt-in): the **database** rejects `DROP`/`DELETE`/writing-CTE/
      multi-statement writes (not a string check) — verified by test.
- [ ] Writable connection (default): a destructive statement triggers a confirm dialog
      before executing (conservative classifier — ambiguous treated as destructive) — verified by test.
- [ ] Cancel issues a real server-side cancel; the connection is freed for the next query.
- [ ] Huge result does NOT freeze the main thread (cursor-bounded, not whole-buffer).
- [ ] Monaco shows SQL syntax highlighting.
- [ ] SQL errors inline without leaking credentials; works on macOS/Linux/Windows.
- [ ] Typecheck + lint + unit tests green.

## Risk Assessment

- Keyword classification is heuristic. For read-only connections the DB read-only
  transaction is the real backstop (classifier edge cases aren't security-relevant). For
  the **default writable** connection there is no DB backstop, so the confirm dialog is
  the only guard against an accidental DROP/DELETE — make destructive detection
  conservative (treat ambiguous as destructive → confirm).
- Cursor/stream APIs differ per driver — keep behind the `DbDriver` abstraction and test each.

## Red Team Hardening (applied)

- **F3 (Critical) + validated:** DB-level read-only transaction + `multipleStatements:false`
  for opt-in read-only connections; `allowWrite` enforced server-side from `readOnly`.
  Default is writable (validated) → conservative confirm dialog is the primary write guard.
- **F9 (High):** server-side cursor bounded to `rowLimit+1`; no `LIMIT` append; no whole-buffer clone.
- **F4/F10 (High):** real cancel via separate connection + backendPid; document pooled-query limitation.
- **F13 (High):** register the Monaco SQL basic-language (no plaintext fallback).
