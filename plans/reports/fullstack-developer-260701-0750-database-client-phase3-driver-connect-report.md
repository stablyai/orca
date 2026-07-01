# Database Client Phase 3 — Driver Abstraction & Connect

Date: 2026-07-01
Branch: feat/database-client
Scope: `DbDriver` abstraction (PG/MySQL lazy-imported), resilient connection
manager, test/connect/disconnect IPC, preload + store + UI wiring.

## Delivered

### Main process
- `src/main/database/db-driver.ts` — `DbDriver` type, `ResolvedDbConfig`,
  `LiveConnection`, `resolveSslMode` (smart-by-host), `resolveDbConfig`,
  `raceWithTimeout`/`DbTimeoutError` (30s, mirrors SSH), `normalizeDbError`
  (allow-list → `{code, safeMessage}`; never forwards raw driver message/DSN).
- `src/main/database/postgres-driver.ts` — lazy `await import('pg')`; pool
  (max 2 = query + introspection), `connectionTimeoutMillis`, `buildPgSsl`
  (verify-full → `rejectUnauthorized:true`), mandatory pool `'error'` listener.
- `src/main/database/mysql-driver.ts` — lazy `await import('mysql2/promise')`;
  `connectTimeout`, `connectionLimit:2`, `multipleStatements:false`,
  `infileStreamFactory:undefined` (LOCAL INFILE stays off), per-connection
  `'error'` wiring via the core pool `'connection'` event.
- `src/main/database/db-connection-manager.ts` — live-connection map +
  `connectingTargets` race guard + status broadcast; driver `'error'` → `lost`
  (drop from map, background close, **never re-throw**) ; `disconnectAll()`.
- `src/main/ipc/database.ts` — `test`/`connect`/`disconnect`/`statuses`
  handlers; strict fail-closed decrypt at point-of-use; `isTrustedUIRenderer`
  gate on every channel; errors returned redacted (never raw); status
  broadcast to all windows (`database:status-changed`).
- `src/main/index.ts` — `dbConnectionManager.disconnectAll()` wired into
  `will-quit` (red-team F12 — SSH's manager is never disposed on quit).

### Renderer / bridge
- Preload (`index.ts` + `api-types.ts`): `test/connect/disconnect/statuses` +
  `onStatusChanged` event subscription. Web stub returns unavailable.
- Store slice: `dbStatuses` map + `connectDbConnection`/`disconnectDbConnection`/
  `testDbConnection`/`subscribeDbStatusChanges`; `loadDbConnections` hydrates
  statuses; `removeDbConnection` disconnects first.
- UI: `connection-status-indicator.tsx` (dot + label); `ConnectionList` gains
  Connect/Disconnect/Reconnect + live status; `ConnectionForm` gains Test.
  `DatabasePage` subscribes to live status for its lifetime.
- i18n: 15 keys added to all 5 catalogs (locale parity preserved).

## Red-team findings addressed
F4 (`'error'` crash) ✓ · F6 (error redaction) ✓ · F7 (SSL smart-by-host +
LOCAL INFILE off) ✓ · F8 (connect timeout) ✓ · F11 (pool: query+introspect) ✓ ·
F12 (quit disposal + race guard) ✓ · F14 (Connect/Disconnect UI) ✓ · F15
(trusted-sender gate) ✓.

## Verification
- Unit tests: **133 passed** (77 Phase 2 + 56 Phase 3) across db-driver,
  postgres-driver, mysql-driver, db-connection-manager, ipc/database.
  Covers: SSL default → `rejectUnauthorized:true`, LOCAL INFILE off,
  no-credential-leak on IPC payloads, race guard, `'error'`→`lost`,
  timeout settles, disconnectAll.
- `typecheck:node` ✓ · `typecheck:web` ✓
- `oxlint` ✓ · switch-exhaustiveness ✓ · localization catalog + coverage ✓

## Notes / deferred
- Live PG/MySQL integration test (docker) left as an optional gated follow-up
  (unit tests mock the drivers).
- introspect (P4) / query + cancel + read-only txn (P5) intentionally not
  implemented here; the pool already reserves a second connection for them.

## Unresolved questions
None.

Status: DONE
