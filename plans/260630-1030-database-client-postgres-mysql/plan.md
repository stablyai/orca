---
title: "Database Client (Postgres/MySQL)"
description: "In-app DB client for Orca: connect to external Postgres/MySQL, browse schema, run SQL, view results. Drivers bundled + lazy-imported. Global connection list, passwords encrypted via safeStorage."
status: pending
priority: P2
branch: "feat/database-client"
tags: [database, feature, renderer, main, ipc]
blockedBy: []
blocks: []
created: "2026-06-30T06:05:55.691Z"
createdBy: "ck:plan"
source: skill
---

# Database Client (Postgres/MySQL)

## Overview

Add a focused database client to Orca so a developer can connect to external
Postgres/MySQL servers, browse schema, run SQL, and view results without leaving
the app. Mirrors Orca's existing **SSH feature** (connection list + encrypted
secrets + tunnel seam) and the **Skills** top-level view shell. Drivers (`pg`,
`mysql2`) are **bundled and lazy-imported** (`await import(...)` on first connect)
— no runtime download. Queries run in the **main process** (raw TCP); the
sandboxed renderer talks over IPC.

Brainstorm: `plans/reports/brainstorm-260630-1030-database-client-postgres-mysql-report.md`

## Phases

| Phase | Name | Status |
|-------|------|--------|
| 1 | [Scaffold and Driver Deps](./phase-01-scaffold-and-driver-deps.md) | Done |
| 2 | [Connection Model and Secure Persistence](./phase-02-connection-model-and-secure-persistence.md) | Done |
| 3 | [Driver Abstraction and Connect](./phase-03-driver-abstraction-and-connect.md) | Done |
| 4 | [Schema Browser](./phase-04-schema-browser.md) | Done |
| 5 | [Query Editor and Results Grid](./phase-05-query-editor-and-results-grid.md) | Done |

Build order is strictly sequential: P1 → P2 → P3 → P4 → P5. P3 depends on P2's
connection model; P4/P5 depend on P3's live connection manager.

## Acceptance Criteria (whole plan)

- [ ] `Database` top-level view opens from the sidebar on macOS/Linux/Windows.
- [ ] Add/edit/delete a connection (Postgres + MySQL); password encrypted with a
      **strong** `safeStorage` backend; on weak/absent backend (`basic_text`/headless
      Linux) the app shows a banner and **warns + stores with consent** (validated),
      never a *silent* weak write.
- [ ] Test Connection performs a real ping and **settles within a connect timeout**
      (no infinite hang on a dead host).
- [ ] Explicit Connect/Disconnect controls; a dropped connection degrades to `lost`
      **without crashing the app**.
- [ ] Schema tree: connection → databases/schemas → tables/views → columns+types,
      lazy + capped (no freeze on huge catalogs).
- [ ] SQL editor (with SQL highlighting) runs a `SELECT`; cursor-bounded results in a
      virtualized grid; `truncated` shown past the cap.
- [ ] Read-only connection (opt-in): the **database** rejects writes (incl.
      multi-statement / writing-CTE), not a keyword check. New connections default
      **writable** (validated); a conservative confirm dialog guards destructive statements.
- [ ] Long queries cancellable **server-side**; statement + connect timeouts enforced.
- [ ] Packaged build resolves `pg`/`mysql2` (allowlist + `verifyPackagedMainRuntimeDeps`);
      drivers absent from the main-process startup require graph until first connect.

## Constraints (non-negotiable)

- Queries + drivers in **main process** only; renderer over IPC; `database:*` handlers
  gated by `isTrustedUIRenderer`.
- DB passwords use a **strong** `safeStorage` backend; on weak `basic_text`/no backend,
  **warn-and-store** behind a banner (validated) — with strict fail-closed decrypt and a
  hardened at-rest file. NOT the cookie-grade `encrypt()`/plain `orca-data.json` path.
- Read-only (opt-in) enforced at the **database** (read-only transaction); new
  connections default **writable** (validated), guarded by a conservative
  confirm-on-destructive dialog — not by keyword as a security boundary.
- Drivers bundled via the packaged-runtime **allowlist** + lazy `await import()`
  (main-process precedent `filesystem-watcher.ts:296`) — not downloaded, not the
  renderer code-split.
- SSL default is **smart-by-host** (localhost → disable, remote → verify-full,
  validated); `localInfile:false`; non-verifying is explicit opt-in.
- v1 dials from the **local** main process — surface a UI disclosure when the active
  workspace is SSH-remote (true tunnel deferred); don't silently connect to the wrong host.
- Cross-platform paths (`path.join`); STYLEGUIDE tokens + shadcn primitives; no
  `max-lines` disables; no vague `*-utils`/`*-helpers` names.

## Out of Scope (v1)

Network driver download; per-worktree connections; SSH-tunnel **implementation**
(model field `sshTunnel` reserved, wired later via `SshPortForwardManager`);
engines beyond PG/MySQL; ER diagrams; migrations; data-edit grid; `.env`/
`DATABASE_URL` import (roadmap).

## Dependencies

No cross-plan dependencies (no other unfinished plans). New npm deps: `pg`,
`mysql2`, `@types/pg`. Reused: `secure-file`, Monaco (SQL language registered),
`@tanstack/react-virtual`, `isTrustedUIRenderer`, `SshPortForwardManager` (later).
DB credentials use a dedicated strong-backend store, **not** the cookie-grade
`safeStorage` `encrypt()` path.

## Red Team Review

### Session — 2026-06-30
**Findings:** 15 (15 accepted, 0 rejected) — deduped from 23 raw across 3 reviewers
(Security Adversary, Failure Mode Analyst, Assumption Destroyer).
**Severity breakdown:** 4 Critical, 10 High, 1 Medium (+ folded sub-points).
All findings carried `file:line` codebase evidence (evidence filter: 15/15 pass).

| # | Finding | Severity | Disposition | Applied To |
|---|---------|----------|-------------|------------|
| 1 | Drivers not in packaged-runtime allowlist → prod `MODULE_NOT_FOUND` | Critical | Accept | Phase 1 |
| 2 | safeStorage degrades to plaintext/`basic_text`; planned warning never fires | Critical | Accept | Phase 2 |
| 3 | Read-only write guard is keyword-only; multi-statement/CTE bypass | Critical | Accept | Phase 5 (+P2 model) |
| 4 | Unhandled connection `'error'` event crashes the whole main process | Critical | Accept | Phase 3 |
| 5 | `orca-data.json` not ACL-hardened; password relies on hollow ciphertext | High | Accept | Phase 2 |
| 6 | Error redaction hand-waved; no IPC redactor → DSN/password leak | High | Accept | Phase 3 |
| 7 | SSL defaults non-verifying + `mysql2 localInfile` not disabled | High | Accept | Phase 3 |
| 8 | No connect timeout → indefinite hang + socket leak | High | Accept | Phase 3 |
| 9 | Full-buffer + structured-clone of results/introspect → freeze/OOM | High | Accept | Phase 4 + 5 |
| 10 | Cancel is a no-op (AbortController can't abort pg/mysql query) | High | Accept | Phase 5 |
| 11 | Single shared connection → introspect/query contention | High | Accept | Phase 3 + 4 |
| 12 | Quit-dispose unwired (mirrored SSH never disposes); race guard dropped | High | Accept | Phase 3 |
| 13 | Monaco SQL language not registered → plaintext editor | High | Accept | Phase 5 |
| 14 | No Connect/Open UI action; P4 assumes a live connection | High | Accept | Phase 3 |
| 15 | IPC lacks trusted-sender gate; local-dial ignores SSH-remote context | Medium | Accept | Phase 2/3 + plan constraints |

**Folded sub-points:** F4-lazy-precedent (renderer→main `filesystem-watcher.ts:296`,
cold-start check fixed) → P1; strict fail-closed decrypt → P2; `readOnly` default in
P2 model + normalize → P2/P5; double-connect race guard → P3; capped introspection → P4.

### Whole-Plan Consistency Sweep
Re-read `plan.md` + all 5 phase files after applying findings. Decision deltas
reconciled across the plan:
- `safeStorage encrypt()` reuse → replaced everywhere by the strong-backend credential
  store; removed from Dependencies/Constraints/acceptance.
- "Mermaid lazy pattern" → main-process `filesystem-watcher.ts:296`; cold-start
  acceptance criterion → main-process require-graph check.
- `readOnly` now defined in P2 model + normalize (was P5-only); P5 references it as existing.
- Keyword write guard demoted to UX hint in P5 + risk notes; DB read-only txn is the boundary.
- SSL field values updated to `disable | verify-full | insecure-no-verify` in P2 model
  and P3 driver config (was `disable | require | verify-full`).
- Result/introspect transport → cursor-bounded in P4/P5; "append LIMIT" removed.
- Connection status union extended to include `lost` in P3 (and referenced in P3 UI).

**Result:** zero unresolved contradictions. Plan ready for `/ck:plan validate` or `/ck:cook`.

## Validation Log

### Session 1 — 2026-06-30
**Verification pass:** skipped (guard) — `## Red Team Review` already carries `file:line`
evidence; no `[UNVERIFIED]` tags remained. Verification Results: Failed: 0.
**Questions asked:** 4 (genuine open decisions only).

| # | Decision point | Chosen | Note |
|---|----------------|--------|------|
| 1 | Weak crypto-backend password policy | **Warn + store anyway** | Banner + informed consent; keeps headless/SSH devs working. → P2 |
| 2 | Default SSL mode (new connection) | **Smart-by-host** | localhost→disable, remote→verify-full. → P2/P3 |
| 3 | Default read/write mode | **Writable** | Against the read-only rec/red-team lean; user-owned tradeoff. Confirm-dialog becomes primary write guard. → P2/P5 |
| 4 | v1 scope weight (post red-team) | **Keep full v1 (P1→P5)** | Phases sequential + independently shippable; no scope cut. |

**Explicit user-decision flag (per review rules):** #3 writable-default reverses the
recommended read-only-by-default and the red-team safety lean. Recorded as a deliberate,
informed user decision. Mitigation propagated: P5 destructive-statement **confirm dialog**
is now the primary safety net for the default (writable) connection (read-only stays
opt-in + DB-enforced).

### Whole-Plan Consistency Sweep (post-validation)
Re-read `plan.md` + all 5 phase files. Reconciled across the plan:
- `readOnly` default flipped `true → false` everywhere: P2 model + normalize
  (`readOnly ?? false`), P5 guard/confirm-net, plan acceptance + constraints.
- SSL default `verify-full → smart-by-host` everywhere: P2 model, P3 driver/criteria/risk,
  plan constraints. `DbSslMode` enum unchanged (`disable | verify-full | insecure-no-verify`).
- Weak-backend policy resolved from "decide block vs warn" → **warn-and-store** in P2
  steps/criteria/risk + plan acceptance/constraints.
- Scope unchanged (full v1) — no phase added/removed.

**Result:** zero unresolved contradictions. Verification Failed: 0 → eligible for `/ck:cook`.
