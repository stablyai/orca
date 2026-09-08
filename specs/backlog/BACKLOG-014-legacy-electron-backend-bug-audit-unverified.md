# BACKLOG-014: Legacy Electron/Node backend has ~70 unverified bug findings from a 5-6-week-old audit round — never re-checked, and that backend is confirmed still live in production

**Origin:** Consolidates 4 top-level index files that lived loose at `specs/` root (not under any of `specs/{backend,backend-go,frontend,agent,emulator}/`'s organized trees): `BUGS-INDEX.md`, `TERMINAL-BUGS-INDEX.md`, `AUDIT-REPORT-batch2-domains.md`, `AUDIT-REPORT-batch3-runtime-domains.md`. Deleted after this entry was written — their content is summarized below; the underlying per-bug detail files (`specs/{backend,frontend,agent}/bugs/hld-v1/`, `agent-orchestration/`, `terminals/`, etc.) were NOT deleted and NOT individually re-verified in this pass (out of scope — see "What this doesn't cover").
**Priority:** Medium — real, plausible bugs in code that's confirmed still serving production traffic, but severity/currency is unverified, not confirmed-critical
**Blocked on:** A re-verification pass (is each finding still true against current code) before any of it is actionable — same "audit went stale" pattern `specs/backend-go/bugs/missing-v1/README.md`/`logic-v1/README.md` explicitly warn about for their own domain

---

## What this is

All 4 source documents were dated **2026-08-01** (or 2026-07-30 for a related conflict-analysis doc), auditing the **old Electron/Node codebase** (`src/main/`, `src/relay/`, `src/renderer/` — no `backend-go/` paths anywhere) against `docs/flows/logic/` HLD specs. Combined, they catalog:

- **`BUGS-INDEX.md`**: 26 bugs across agent-ws, ai-providers, auth, worktree-mgmt, code-review, mobile-companion, fleet, workflow-orch, cli-headless, task-graph, automation, remote-dev, plus a code-health finding (111 frontend files >1,000 lines). 3 CRITICAL, 12 HIGH, 11 MEDIUM, 4 already-fixed false-positives.
- **`TERMINAL-BUGS-INDEX.md`**: 14 bugs specifically in the `terminal.create` flow (Browser→Backend→Dev Server Agent) — 6 HIGH (binary frame corruption, port mismatch, session leak, missing HMAC/path-traversal validation on `pty.spawn`, missing scrollback snapshot), 5 MEDIUM, 2 LOW.
- **`AUDIT-REPORT-batch2-domains.md`**: 16 bugs across agent-ws, ai-providers, auth, automation, code-review, cli-headless — headline: new AI-provider accounts unusable for 15 min (`status='pending'` never resolves without a health-checker running), and `agent-ws`'s documented topology (Orca dials into Dev Server) is backwards from what's actually implemented (Dev Server dials Orca).
- **`AUDIT-REPORT-batch3-runtime-domains.md`**: 15 bugs across terminal-mgmt, worktree-mgmt, task-graph, workflow-orch, project-workspace/integration, remote-integration — headline: relay dispatch was missing `pty.*` and `agent.exec` handlers entirely (CRITICAL — no PTY or agent could run on a remote Dev Server at all), and `StepExecutors.executeCondition()` used `new Function()` on workflow condition expressions (RCE risk).

## Why this can't be dismissed as pure history

`specs/backend-go/bugs/task-v1/README.md` (dated **2026-09-08**, today, the most current audit in the whole `specs/` tree) states directly, in its own Postgres-compliance table:

> Production deployment (`deploy/prod/docker-compose.yml`): ❌ Non-compliant — **still the Node backend, SQLite-backed, zero backend-go containers**.
> Desktop Electron app: ❌ Non-compliant — `desktop/src/main/task/task-rpc-handler.ts` / `workflow/workflow-rpc-handler.ts` **still serve all 3 systems via the Node/SQLite backend**.

So the exact codebase these 4 documents audited is **not dead legacy code** — it's still running in production for Task/Workflow systems, and entirely for the desktop Electron app (a real, shipped product surface per `AGENTS.md`'s cross-platform requirements). A HIGH/CRITICAL finding here (e.g. the RCE-shaped `new Function()` one, or the missing PTY/agent.exec relay handlers) could be a real, live production issue — or could have been fixed independently in the 5-6 weeks since, same as `missing-v1`'s own findings partially went stale by the time `logic-v1` re-checked them a few weeks later.

## What NOT to do

Don't assume these are all still valid and start fixing them — several are plausibly already fixed (the same drift `specs/backend-go/bugs/logic-v1/README.md` documented happening to `missing-v1` over just a few weeks). Don't assume they're all stale either — the backend they target is confirmed still serving real traffic, unlike a purely historical audit of fully-replaced code.

## What this doesn't cover

- The underlying per-bug detail files this index summarized (`specs/backend/bugs/*`, `specs/frontend/bugs/*`, `specs/agent/bugs/*` — hundreds of files) were **not** read, verified, or deleted in this pass — only the 4 top-level index files (loose at `specs/` root) were consolidated here and removed. Re-verifying or triaging those detail files is exactly the deferred work this entry exists to flag.
- `backend-go/`'s own bug tracking (`missing-v1/v2/v3`, `logic-v1`, `task-v1`, `api-v1`) is a **separate, current, actively-maintained** audit trail — already reflected accurately elsewhere in this backlog (or already resolved, per `missing-v3`'s own README) — not what this entry is about.

## Suggested next step for whoever picks this up

Before fixing anything: pick the highest-severity items (the RCE-shaped `new Function()` finding and the "relay missing `agent.exec`/`pty.*` handlers entirely" finding are the two that would matter most if still true) and confirm directly against current `src/main/workflow/StepExecutors.ts` / `src/relay/agent-rpc-dispatch.ts` (or their current equivalents/successors) whether they're still accurate before trusting anything else in this list.
