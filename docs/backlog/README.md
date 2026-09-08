# Backlog

Work that's genuinely **not ready to implement yet** — each blocked on a
missing dependency (unbuilt agent capability, unbuilt upstream feature) or a
decision only a human/product owner can make, not on more engineering time.
Most of this was surfaced by the `specs/backend-go/bugs/missing-v3/`
audit-and-fix pass (2026-09-07/08); this directory exists so the remaining
work is discoverable without wading back into that bug/solution/task
directory tree, which is now otherwise fully resolved.

Each entry restates its own context standalone — you shouldn't need to open
`missing-v3/` to understand what it is — but links back to the original
`BUG-XXX`/`TASK-XXX` file for full investigation detail and evidence.

Resolved items are removed from this directory once confirmed closed, not
kept as a historical record — see each service/CR's own tracking docs
(`specs/backend-go/bugs/missing-v3/`, `specs/{agent,backend-go,frontend}/crs/`)
for closed-item history.

This directory was moved here from `specs/backlog/` (2026-09-08) so every
backlog item lives in one place — see [`TODO.md`](./TODO.md), a separate,
manually-maintained list of larger initiatives (surveyed/planned but not
yet built, or reverted) that predates this directory and uses its own
format; the two are complementary, not duplicates.

## Index

| ID | Title | Blocked on | Priority |
|----|-------|-----------|----------|
| [BACKLOG-001](./BACKLOG-001-ephemeralvm-ssh-outbound-client.md) | Ephemeral VM `ssh`-connection-type lifecycle | New `agent/` outbound SSH-client subsystem | Low |
| [BACKLOG-002](./BACKLOG-002-environment-devserver-resolution.md) | Resolve a bare runtime `environmentId` to a dev server (unblocks `terminal.create` and `files.browseServerDir` for connectionless environments) | `ephemeralVm.provision` (doesn't exist yet) | Medium |
| [BACKLOG-003](./BACKLOG-003-files-watch-streaming-transport.md) | `files.watch` — live external file-change notifications for remote/environment targets | New streaming transport, agent→git-gateway-service→wscompat | Medium |
| [BACKLOG-004](./BACKLOG-004-browser-profile-import-live-wiring.md) | Wire up `browser.profileImportFromBrowser`'s real cookie-import orchestration | Needs real-browser/live-OS-keychain testing before shipping | Low |
| [BACKLOG-005](./BACKLOG-005-telemetry-consent-identity-decision.md) | `telemetry.track` — pick a consent/identity model for backend-go, then implement it | **Human product/privacy decision**, not engineering | Low (until decided) |
| [BACKLOG-009](./BACKLOG-009-orchestration-service-fail-dispatch-missing.md) | `FailDispatch` RPC built and tested (circuit-breaker for real); its intended caller (`TASK-TASKV1-005-10`'s tick loop) is fully speced but, per 2026-09-08 re-check, **`TASK-TASKV1-005-01..09` it depends on is unimplemented** — same root cause as BACKLOG-017 | `TASK-TASKV1-005-01..09` (CoordinatorRun domain/repo/usecases, 2 new adapters, 6 new proto RPCs) — a real implementation pass, not a design decision | Low-Medium |
| [BACKLOG-012](./BACKLOG-012-worktree-missing-infra-connections-row-local-exec-fallback.md) | Dev-server-backed worktree with no `infra.connections` row falls back to running `git status` LOCALLY inside git-gateway-service's own (distroless, repo-less) container — `GITGATEWAY_STATUS_FAILED` | Root cause not yet diagnosed | Medium-High |
| [BACKLOG-013](./BACKLOG-013-dispatch-context-handle-worktree-linkage.md) | Backend RESOLVED 2026-09-08: `dispatch_contexts.worktree_id` added, threaded end-to-end. Frontend `mapDispatchContextsToSessions` wiring still open (small, unblocked) | Frontend wiring only — no backend blocker remains | Low |
| [BACKLOG-014](./BACKLOG-014-legacy-electron-backend-bug-audit-unverified.md) | Legacy Electron/Node backend (still live in prod for Task/Workflow + all of desktop) has ~70 unverified bug findings from a 5-6-week-old audit (consolidates 4 loose top-level index files, now removed). 2026-09-08: the 2 highest-severity findings (`new Function()` RCE, missing relay `agent.exec`/`pty.*` handlers) checked — both were already fixed days after the audit, no action needed; ~68 findings still unverified | A re-verification pass against current code for the remaining ~68 findings | Medium |
| [BACKLOG-015](./BACKLOG-015-task-graph-rpcs-not-wired-to-wscompat.md) | `AddEdge`/`Grant`/`ResolvePermission` now wired to `wscompat`; `AddComment`/`ListComments` still don't exist at any layer — `TaskComments` UI sits on fallback | Needs new usecase+proto+migration design | Medium |
| [BACKLOG-017](./BACKLOG-017-orchestration-service-new-rpcs-not-exposed-to-frontend.md) | 6 `orchestration-service` coordinator-lifecycle RPCs this item assumed existed (`StartCoordinatorRun`, `GetCoordinatorRun`, `CompleteCoordinatorRun`, `FailCoordinatorRun`, `RecordHeartbeat`, `ListPendingDecisionGates`) — per 2026-09-08 re-check, **none exist at any layer** (proto/usecase/gRPC), not just unwired from `wscompat` | Same as BACKLOG-009: `TASK-TASKV1-005-01..09` is unimplemented | Medium |

## Status of everything else

Every other finding from the `missing-v3` pass (16 bugs, 10 solutions, 42
tasks, plus the follow-on `onboarding.openGhAuthTerminal` implementation and
the direct `BUG-015`/`BUG-016` fixes) is done and verified — see
`specs/backend-go/bugs/missing-v3/README.md` and
`specs/backend-go/bugs/missing-v3/tasks/README.md` for the full record.

The `docs/crs/v3/storage/` storage-consolidation effort (a separate, later
effort) is **in progress, not backlog** — most of its ~37 tasks across
`specs/{agent,backend-go,frontend}/crs/v3/storage/tasks/` are done or
actively being worked; see those directories' own READMEs for live status.
