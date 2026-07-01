---
phase: 3
title: "Driver Abstraction and Connect"
status: done
effort: "L"
---

# Phase 3: Driver Abstraction and Connect

<!-- Updated: Validation Session 1 - SSL default = smart-by-host (localhost→disable, remote→verify-full) -->

## Overview

Introduce a `DbDriver` interface with Postgres/MySQL implementations (lazy-imported),
a connection manager that owns live connections **with full lifecycle resilience**
(connect timeout, `'error'` handling, reconnect, race guard, quit disposal), and the
`test`/`connect`/`disconnect` IPC. A dropped DB connection must never crash Orca.

## Requirements

- Functional: Test Connection pings within a bounded time; a saved connection can be
  **opened (held live) and closed via explicit UI controls**; SSL verifies certs by
  default; dropped connections degrade gracefully (no app crash).
- Non-functional: drivers loaded only on first use; connect bounded by a timeout;
  every live connection has an `'error'` listener; quit disposes all; `database:*`
  handlers reject untrusted senders.

## Architecture

`DbDriver` abstracts the operations the UI needs. `db-connection-manager` mirrors
`ssh-connection-manager` **including the parts that matter for resilience**:

- **`'error'` listener (red-team F4, Critical):** `pg.Client`/`pg.Pool` and `mysql2`
  connections are EventEmitters; an `'error'` with no listener is re-thrown and
  **crashes the main process** (kills every PTY/SSH/terminal). Each live connection
  MUST attach an `'error'` handler that marks it dead, removes it from the map, and
  pushes a `lost` status to the renderer. `index.ts` quit hooks (~`:1788`/`:1807`)
  contain no DB/SSH teardown today, so disposal must be wired explicitly.
- **Connect timeout (red-team F8, High):** set `connectionTimeoutMillis` (pg) and
  `connectTimeout` (mysql2) — mirror SSH's `readyTimeout` 30s — and wrap test/connect
  in a `Promise.race` so the IPC always settles. pg default is wait-forever.
- **Per-connection pool / separate introspection connection (red-team F11, High):** a
  single shared connection serializes introspection and queries, and a destroy-based
  cancel kills both. Use a small pool (or a dedicated introspection connection apart
  from the query connection).
- **Double-connect race guard (red-team F12):** carry over SSH's `connectingTargets`
  set (`ssh-connection-manager.ts:12-15,34-38`) so two concurrent `connect(sameId)`
  don't orphan a socket.
- **Quit disposal (red-team F12):** SSH's `disconnectAll()` is only called from test
  teardown — "mirror SSH" yields NO quit disposal. Add `src/main/index.ts` to the
  file list and wire `dbConnectionManager.disconnectAll()` into `will-quit`. Add an
  idle-timeout/connection cap as an implementation step.
- **SSL (red-team F7 + validated):** default is **smart-by-host** — localhost/
  127.0.0.1 → `disable` (normal for local dev); any remote host → `verify-full`
  (`rejectUnauthorized: true`). `'insecure-no-verify'` is an explicit, clearly-labeled
  opt-in, never the default. Set `localInfile: false` on mysql2 to close the
  client-file-read vector.
- **Error normalization (red-team F6, High):** never forward raw driver errors over
  IPC (they embed DSNs/passwords; no IPC redactor exists today). Return a fixed
  `{ code, safeMessage }` built from an allow-list.
- **Trusted-sender gate (red-team F15):** `database:*` handlers must check
  `isTrustedUIRenderer(event.sender)` (pattern in `src/main/ipc/ui.ts:47`) — the
  mirror target `registerSkillsHandlers` validates nothing.

```ts
// src/main/database/db-driver.ts
export interface DbDriver {
  testConnection(cfg: ResolvedDbConfig): Promise<void>            // bounded by connect timeout; throws on failure
  connect(cfg: ResolvedDbConfig): Promise<LiveConnection>        // pool-backed; attaches 'error' listener
  introspect(conn: LiveConnection): Promise<DbSchemaTree>        // Phase 4; uses introspection connection
  query(conn: LiveConnection, sql: string, opts: QueryOptions): Promise<QueryResult>  // Phase 5
  cancel(conn: LiveConnection, queryHandle: QueryHandle): Promise<void>  // Phase 5; separate cancel connection
  close(conn: LiveConnection): Promise<void>
}
```

## Related Code Files

- Create: `src/main/database/db-driver.ts` — interface, `ResolvedDbConfig`,
  `LiveConnection`, `{ code, safeMessage }` error normalizer.
- Create: `src/main/database/postgres-driver.ts` — `await import('pg')`; SSL
  (smart-by-host; remote → `rejectUnauthorized:true`); connect timeout; `'error'` wiring.
- Create: `src/main/database/mysql-driver.ts` — `await import('mysql2/promise')`;
  `connectTimeout`; `localInfile:false`; `multipleStatements:false` (Phase 5).
- Create: `src/main/database/db-connection-manager.ts` — pool/live-connection map +
  `connectingTargets` guard + `disconnectAll()` + idle cap (mirror
  `ssh-connection-manager.ts`).
- Modify: `src/main/index.ts` — call `dbConnectionManager.disconnectAll()` in
  `will-quit` (~`:1807`).
- Modify: `src/main/ipc/database.ts` — `test|connect|disconnect`; decrypt creds
  (strict, from Phase 2); normalize errors; `isTrustedUIRenderer` gate.
- Modify: `src/preload/index.ts` — add `test/connect/disconnect`.
- Modify: `src/renderer/src/store/slices/database.ts` — status union
  `idle|testing|connecting|connected|error|lost` + actions.
- Modify: `ConnectionForm.tsx` / `ConnectionList.tsx` — Test **and** an explicit
  **Connect/Disconnect** control (red-team F14); show status/inline error/`lost`.

## Implementation Steps

1. Define `DbDriver` + shared types + error normalizer in `db-driver.ts`.
2. Implement `postgres-driver.ts` (lazy import; SSL verify default; connect timeout;
   `testConnection` via `SELECT 1`; attach `'error'` listener).
3. Implement `mysql-driver.ts` (lazy import; `connectTimeout`; `localInfile:false`;
   `'error'` listener; `SELECT 1`).
4. Build `db-connection-manager.ts`: pick driver by `engine`; pool or
   introspection+query connections; `connectingTargets` guard; idle cap; `disconnectAll()`.
5. Wire `disconnectAll()` into `index.ts` `will-quit`.
6. Add `test/connect/disconnect` handlers (trusted-sender gate; strict decrypt;
   normalized errors; `Promise.race` timeout).
7. Wire preload + slice + **Connect/Disconnect UI** + status (incl. `lost` → offer reconnect).
8. Tests: error normalization never leaks DSN/password (assert on IPC payload);
   manager open/close/`disconnectAll`; concurrent `connect(sameId)` guarded; connect
   timeout settles; SSL config maps to `rejectUnauthorized:true` by default;
   `localInfile:false`. Optional gated integration test vs local PG+MySQL (docker).

## Success Criteria

- [ ] Test Connection succeeds vs real PG and MySQL, **and settles within the timeout**
      against a dead host (no infinite hang).
- [ ] A dropped/idle-reset connection emits `'error'` → marked `lost`, app does NOT crash.
- [ ] Explicit Connect/Disconnect controls hold/free a live connection; `will-quit`
      disposes all.
- [ ] Concurrent double-Connect does not orphan a socket.
- [ ] SSL smart-by-host (remote → cert-verified, localhost → disabled); `insecure-no-verify` opt-in; `localInfile` off.
- [ ] Driver errors crossing IPC contain no credentials (test asserts).
- [ ] Untrusted webContents cannot invoke `database:*` (test asserts).
- [ ] Typecheck + lint + unit tests green.

## Risk Assessment

- SSL `verify-full` (remote default) needs CA/hostname handling — if a custom CA path
  is deferred, still keep `rejectUnauthorized:true` for remote; never make a remote host
  silently non-verifying. localhost defaults to `disable` (no cert to verify).
- Pool sizing: keep small (e.g. 1 query + 1 introspection) to bound server backends.

## Red Team Hardening (applied)

- **F4 (Critical):** mandatory `'error'` listener + `lost` state + reconnect path.
- **F8 (High):** connect timeout (mirror SSH 30s) + `Promise.race`.
- **F11 (High):** per-connection pool / separate introspection connection.
- **F12 (High):** wire `disconnectAll()` into `index.ts will-quit`; idle cap as a step;
  carry over the `connectingTargets` double-connect guard.
- **F7 (High) + validated:** smart-by-host SSL (remote → verifies, localhost → disabled);
  `localInfile:false`; insecure opt-in.
- **F6 (High):** `{ code, safeMessage }` normalizer; test no-credential-leak.
- **F15 (Medium):** `isTrustedUIRenderer` gate on `database:*`.
- **F14 (High):** explicit Connect/Disconnect UI (Test alone can't hold a connection for P4).
