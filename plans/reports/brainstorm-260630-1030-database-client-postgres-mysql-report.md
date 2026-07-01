---
title: Database Client (Postgres/MySQL) for Orca — Brainstorm
date: 2026-06-30
branch: feat/database-client
status: approved — handed off to /ck:plan
modes: []
related_files:
  - src/renderer/src/store/slices/ssh.ts
  - src/main/ipc/ssh.ts
  - src/main/ssh/ssh-port-forward.ts
  - src/main/persistence.ts
  - src/renderer/src/components/skills/SkillsPage.tsx
---

# Database Client for Orca — Brainstorm Report

## 1. Problem Statement

Developers using Orca leave the app to inspect the database their code/agent works
against (DBeaver, TablePlus, psql). Real problem: **data lives one app away from the
code**. Goal — a focused Postgres/MySQL client inside Orca so browsing schema and
running queries happens beside the worktree, not in another window.

### Problem-first check (user arrived with a solution)
- **Stated solution:** "Manage database with built-in Postgres/MySQL; on add connection → auto-download driver."
- **Underlying problem:** context-switch cost between code and its data.
- **Assumption corrected:** "download driver" is a JDBC/ODBC mental model. In Node/Electron, `pg` and `mysql2` are pure-JS npm packages. Bundling + lazy-`import()` delivers the same "driver ready on connect" UX without runtime download. User accepted this reframing.

## 2. Locked Requirements

| Item | Decision |
|---|---|
| Feature type | DB **client** (connect to external PG/MySQL servers) |
| Primary user | Developer, manual use (human browsing + querying) |
| v1 scope | **Full client**: connections + schema browser + SQL editor + results grid |
| Driver delivery | **Bundle + lazy-import** (`await import('pg'|'mysql2')` on first connect) |
| UI placement | **Top-level full-screen view** (`'database'`), like Skills/Tasks |
| SSH tunnel | **Defer, reserve seam** — `sshTunnel` field in model, wired later |
| Connection scope | **Global** — one list in `orca-data.json`, mirror `sshTargets` |

**Out of scope (v1):** network driver download, per-worktree connections, SSH-tunnel
implementation, engines beyond PG/MySQL, ER diagrams, migrations, data-edit grid.

## 3. Evaluated Approaches

### 3a. Driver delivery
| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Bundle + lazy-import** | Lean startup, offline + SSH-remote safe, zero security surface | +3–5MB installer | ✅ Chosen |
| True network download | Matches "download" literally | Executes downloaded JS, breaks offline/SSH, needs sig-verify | ❌ |
| Bundle one, download other | — | More moving parts, no real gain | ❌ |

### 3b. UI placement
| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Top-level view** | Simplest; matches global connections; mirrors `SkillsPage` | Not docked to a worktree | ✅ Chosen |
| In-worktree pane | DB next to code | More plumbing, per-worktree context | Later |

### 3c. Where queries run
Renderer is sandboxed (no raw TCP). **Drivers + queries run in the main process**;
renderer talks over IPC. Non-negotiable.

## 4. Recommended Solution

Mirror Orca's **SSH feature** (connection list + encrypted secrets + tunnels = a DB
client minus SQL) and the **Skills view** shell.

### Module layout
```
src/shared/database-types.ts                # DbConnection, DbColumn, QueryResult, DbEngine
src/main/database/
  db-driver.ts                              # DbDriver interface
  postgres-driver.ts                        # await import('pg'); SSL modes; schema-aware introspect
  mysql-driver.ts                           # await import('mysql2/promise')
  db-connection-manager.ts                  # live connection lifecycle (mirror ssh-connection-manager)
src/main/ipc/database.ts                    # test|connect|disconnect|introspect|query|list|add|update|remove
src/renderer/src/store/slices/database.ts   # mirror ssh.ts
src/renderer/src/components/database/        # DatabasePage, ConnectionList, ConnectionForm, SchemaTree, QueryEditor, ResultsGrid
```

### Touchpoints (existing files)
- `src/renderer/src/store/slices/ui.ts:547` — add `'database'` to view union (+ setter).
- `src/renderer/src/App.tsx:2259` — route `activeView === 'database'` → `DatabasePage` (lazy).
- Sidebar nav button (mirror `SidebarTaskNavButton.tsx`).
- `src/main/ipc/register-core-handlers.ts` — `registerDatabaseHandlers(store)`.
- `src/preload/index.ts` — `window.api.database.*` (invoke + `on()` for streamed rows).
- `src/main/persistence.ts` — `dbConnections` CRUD mirroring `sshTargets` (`:5579`); password via `encrypt()` (`:213`, `safeStorage`).

### Connection model
```ts
type DbConnection = {
  id: string; name: string; engine: 'postgres' | 'mysql'
  host: string; port: number; database: string; user: string
  password?: string                 // encrypted at rest via safeStorage
  ssl?: 'disable' | 'require' | 'verify-full'
  sshTunnel?: { targetId: string }  // RESERVED — not wired in v1
}
```

## 5. Phasing (→ /ck:plan)
- **P0 Scaffold** — branch (done), add `pg`+`mysql2`, `'database'` view + sidebar + empty page, verify electron-builder bundles pure-JS drivers (no native rebuild).
- **P1 Connections** — types + persistence CRUD + `safeStorage` password + IPC `test/list/add/update/remove` + preload + slice + ConnectionList/Form + real **Test Connection**.
- **P2 Driver layer** — `DbDriver` + postgres/mysql impls (lazy import) + connection-manager + connect/disconnect.
- **P3 Schema browser** — `introspect` (engine-specific: PG schemas vs MySQL DBs) + virtualized SchemaTree.
- **P4 Query + results** — Monaco SQL editor (bundled) + `query` (statement-timeout + LIMIT guard + cancel) + virtualized ResultsGrid (`@tanstack/react-virtual` in deps) + error surfacing.

## 6. Risks & Mitigations
| Risk | Mitigation |
|---|---|
| Destructive SQL (`DROP`, `DELETE`) | Per-connection **read-only toggle** + confirm on non-`SELECT` (recommended for v1) |
| Long query blocks main thread | Statement timeout + cancellation in v1; `utilityProcess` only if needed |
| `safeStorage` weak on keychain-less Linux | Surface warning, don't fail |
| Managed PG requires SSL | `ssl` mode field shipped in v1 |
| Large result sets | Pagination/LIMIT v1; row streaming (events) later |
| `pg`/`mysql2` packaging | Pure-JS — confirm asar bundling, no `electron/rebuild` step |

## 7. Success Metrics / Validation
- Connect to real **PG and MySQL**; browse to a column.
- Run a `SELECT`; paged rows in grid; `DROP` blocked/confirmed when read-only.
- Password unreadable in `orca-data.json`.
- Cold-start JS unchanged (driver absent from eager bundle).
- Green on macOS / Linux / Windows.

## 8. Next Steps & Dependencies
- **Next:** `/ck:plan` with this report → phase plan P0–P4 in `plans/260630-1030-database-client-postgres-mysql/`.
- **New deps:** `pg`, `mysql2` (+ `@types/pg`).
- **Reused:** `SshPortForwardManager.addForward` (P-later tunnel), `encrypt`/`safeStorage`, `secure-file`, Monaco, `@tanstack/react-virtual`.

## 9. Unresolved Questions
1. **Read-only toggle in v1?** Recommended yes; user may cut for minimal v1.
2. **Results: paginated invoke vs streamed events** — v1 paginated; confirm streaming need at plan time.
3. **`mysql2` optional native (compression/crypto)** — verify it bundles without native build on all 3 OSes during P0.
4. **Connection import** (from `.env` / `DATABASE_URL` / existing tools) — nice-to-have, not in v1 scope; flag for roadmap.
