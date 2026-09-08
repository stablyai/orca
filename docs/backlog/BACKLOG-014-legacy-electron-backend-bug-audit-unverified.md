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

---

> **Update 2026-09-08:** Verified the 2 highest-severity findings against current code, per the "Suggested next step" above. **Both are already fixed — neither needed new work.** The repo has since split the old top-level `src/{main,relay}/` into two targets, `backend/src/main/` (headless server, no `relay/`) and `desktop/src/{main,relay}/` (the actual Electron app — the one this backlog and `AGENTS.md`'s cross-platform requirements are about); both copies of the workflow code were checked.
>
> 1. **`new Function()` in `executeCondition` — CONFIRMED it existed, but already fixed before this pass, and independently of this backlog.** Current `backend/src/main/workflow/StepExecutors.ts:254-273` and the identical `desktop/src/main/workflow/StepExecutors.ts:164-183` both call a hand-rolled `evaluateSafeCondition()` (same file, right below `executeCondition`) — a fail-safe interpolate-then-compare evaluator supporting only `${var} == 'x'`, `!=`, numeric `>`/`<`/`>=`/`<=`, and boolean literals; anything else returns `false`. No `new Function()`, `eval`, or other dynamic-code-execution primitive remains anywhere in the file. Git history shows this was fixed in commit `c88c918fa` ("fix(backend): resolve 20 HLD-v1 audit bugs...", **2026-08-09**) — 8 days after the audit's 2026-08-01 date, tracked as `TASK-WF-001`/`BUG-WF-003` (`specs/backend/bugs/workflow-orchestration/tasks/TASK-WF-001-fix-condition-step-eval-injection.md`, status DONE). So the finding was real at audit time and is now stale — no action taken here.
>
> 2. **Relay missing `agent.exec`/`pty.*` handlers — CONFIRMED it was true at audit time, but already fixed, also independently of this backlog.** Current `desktop/src/relay/agent-rpc-dispatch.ts` (there is no `backend/src/relay/` — relay only exists in the desktop/Electron target) has a real, wired `agent.exec` case (line 733, non-interactive subprocess exec via `node:child_process`, called by `StepExecutors.executeAgent()`/`ProfileAwareAgentSpawner`) and a full set of `pty.*` cases — `pty.create` (906), `pty.attach` (919), `pty.write` (932), `pty.resize` (945), `pty.destroy` (958), `pty.scrollback` (971), `pty.sendSignal` (984), `pty.listProcesses` (999) — all inside the `route()` function that `createRpcDispatcher` actually invokes per request, not dead code. Git history: the file's first commit (`f7ca8ce94`, 2026-07-31) genuinely had neither `agent.exec` nor any `pty.*` case — the audit's CRITICAL finding was accurate at that moment. The very next commit (`7940abded`, **2026-08-01**, same day as the audit) already added both; `pty.attach` followed in `837f48b0d` (2026-08-04), and `pty.listProcesses` later still (`0aefb5c4a`, "implement pty.listProcesses for Dev Server agents (BUG-FE-PTY-001 true root cause)"). So this finding raced its own fix and lost — it was already resolved essentially concurrently with the audit, and is a non-issue today. No action taken here.
>
> **Net result:** 0 of 2 findings needed a fix in this pass. Both were genuine bugs in the codebase's very recent past (audit was accurate when written) but both were independently fixed within days of the audit, before this backlog entry was ever created. This is a data point for triaging the other ~70 findings still unverified in this file: this 5-6-week-old audit round is clearly capturing a codebase that was itself churning fast, so "still open" cannot be assumed for any remaining item without the same current-code check — same pattern `specs/backend-go/bugs/logic-v1/README.md` already documented for `missing-v1`. The other ~70 findings remain unverified; this backlog item is NOT resolved and should stay open until those are checked too.
