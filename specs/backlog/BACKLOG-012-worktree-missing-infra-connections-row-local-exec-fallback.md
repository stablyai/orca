# BACKLOG-012: Dev-server-backed worktree with no `infra.connections` row silently falls back to LOCAL git exec inside git-gateway-service's own container

**Priority:** Medium-High — breaks the Git panel (status/branches/commit-message/etc.) for **every** dev-server-backed worktree in this production deployment today (confirmed system-wide, not one worktree — see update below).
**Blocked on:** Root cause of *why* the provisioning flow never populates `infra.connections` is not yet diagnosed — needs a code trace before a fix can be scoped. Likely engineering work once diagnosed, not a product decision.
**Origin:** Discovered live in production (b15.openledger.vn) as the very next failure exposed once **BACKLOG-011** (`GITGATEWAY_RESOLVE_FAILED`) was fixed and deployed — this is what was underneath it, unmasked, not a regression the fix introduced.

> **Update 2026-09-08:** Queried production Postgres directly
> (`docker exec orca-go-postgres psql -U orca -d infra`):
> `SELECT count(*) FROM infra.connections` → **0 rows, tenant-wide** (not
> scoped to this one worktree). `infra.dev_servers` has 3 rows
> (`dev-01`/`dev-ai`/`test-01`, all `connection_mode=direct-websocket`, all
> `status=pending` — never approved, though `status` isn't enforced
> anywhere per `dev_server.go`'s own doc comment, so that's likely
> unrelated). **Confirms this is systemic**: every dev-server-backed
> worktree's Git panel is broken this way, not just AI-Ops. The open
> question of "how does the PTY/terminal path work at all then" is
> unresolved — `SpawnTerminalSession` (infra-fleet-service) takes a
> `ConnectionID` directly rather than a worktree/dev-server id, so either
> something creates a transient/short-lived connection row for terminal
> spawn that doesn't persist, or the terminal path resolves through an
> entirely separate mechanism that the Git panel's `ResolveConnectionByWorktree`
> path doesn't share. Needs a real code trace (`grep`/codegraph for
> `CreateConnection`/`EstablishConnection` callers), not further log
> archaeology — next session should start there.

---

## What this is

Worktree `84993831-3d5b-4845-94cd-d0b3f8cc4bbb::/opt/aiops-v3` (Project "AI-Ops", dev server `tas-test`, tenant `00000000-0000-0000-0000-000000000001`, user `ea9d6c4b-af01-4e6b-891b-de63f2e11c49` = `admin@b15.openledger.vn`) has a working PTY/terminal connection to its dev server (confirmed live: `[DIAG BUG-FE-PTY-001]` browser console logs show a real shell prompt from `ubuntu@tas-test`) — but its Git panel cannot get status, because `infra-fleet-service`'s `ResolveConnectionByWorktree` finds **no row** in `infra.connections` for this worktree.

Reproduced live, post-BACKLOG-011-fix, from `orca-go-git-gateway` production logs (repeating every ~30s while the Git panel was open):

```
{"level":"ERROR","msg":"rpc failed","method":"/orca.gitgateway.v1.GitGatewayService/GetStatus",
 "error":"rpc error: code = Internal desc = GITGATEWAY_STATUS_FAILED: failed to get git status", ...}
```

Cross-checked in the same time window:
- `orca-go-infra-fleet` logs: **no errors** — `ResolveConnection`/`Relay` calls in that window are clean.
- `orca-go-postgres` logs: **no errors** — the earlier `invalid input syntax for type uuid` (BACKLOG-011) does not recur.

This rules out a resolve-layer or Relay-layer failure. The only remaining path per `get_status.go`'s Execute (`dispatchExecutor` → `executor.GetStatus(ctx, repoPath)`) is that resolution succeeded with **`Connected=false`** (no `infra.connections` row for this `worktree_id`), so `dispatchExecutor` picked the **`local` `GitExecutor`** — running `git status` inside `orca-go-git-gateway`'s own distroless container, against `repoPath = worktreeID` (`"84993831-3d5b-4845-94cd-d0b3f8cc4bbb::/opt/aiops-v3"`, resolver.go's not-connected fallback: `ResolvedConnection{Connected: false, RepoPath: worktreeID}`) — not a real path on this container's filesystem at all, let alone the actual repo, which lives on the remote `tas-test` host reached only via SSH.

This matches `git-gateway-service.md §2`'s documented behavior exactly ("no connectionId → execute locally... retained for local/dev deployments") — the fallback itself isn't the bug; a dev-server-bound worktree ending up in the "no connectionId" branch at all is.

## What's confirmed vs. not yet known

**Confirmed:**
- This worktree has a live, working terminal/PTY connection to its dev server (proves SSH connectivity to `tas-test` works end-to-end through *some* mechanism).
- `infra.connections` has no row keyed by this worktree's `worktree_id` (inferred from clean infra-fleet/Postgres logs + the `GITGATEWAY_STATUS_FAILED` failure mode, not directly queried — nobody ran `SELECT * FROM infra.connections WHERE worktree_id = ...` in this session).
- `git-gateway-runtime.Dockerfile`'s container is distroless (no shell, only `/usr/bin/git` + the `orca` binary) — confirms the "local exec" fallback cannot possibly reach `/opt/aiops-v3` regardless of path formatting, since that path only exists on the remote dev server.

**Not yet known — needs investigation before a fix can be scoped:**
- *Why* this worktree has no `infra.connections` row: was `CreateConnection`/`EstablishConnection` simply never called for it (e.g. it was set up through an older/different provisioning path that predates connection tracking), or is there a bug in whatever *should* call it on worktree creation/first-open for an SSH-backed project?
- Is this isolated to this one worktree/project, or systemic — i.e. does *any* SSH/dev-server-backed worktree in this deployment currently have a working `infra.connections` row, or are they all in this state and the Git panel has been broken for all of them all along (independent of BACKLOG-011)? Not checked in this session.
- Whether the terminal/PTY path that *does* work for this worktree goes through `infra.connections` at all, or a separate mechanism (e.g. `RelayByDevServer`/a dev-server-id-keyed path that doesn't require a `connections` row) — if so, that's a second, parallel resolution scheme this worktree happens to satisfy while the worktree-keyed one it doesn't.

## Suggested next steps for whoever picks this up

1. `SELECT * FROM infra.connections WHERE tenant_id = '00000000-0000-0000-0000-000000000001' AND worktree_id = '84993831-3d5b-4845-94cd-d0b3f8cc4bbb::/opt/aiops-v3';` on the production DB — confirm the row is really absent (vs. some other resolve-path bug reintroducing a false negative).
2. Trace how this worktree's PTY/terminal connection got established (which usecase call created it) and whether that call also creates/should create the matching `infra.connections` row — worktree creation, dev-server "connect" action, or first terminal spawn are the likely candidates.
3. Check whether this is reproducible for a **freshly created** SSH-backed worktree (not just this pre-existing one) — if fresh worktrees also end up connectionless, this is a provisioning-flow bug affecting every dev-server-backed project going forward, not a one-off data-repair case.
4. If it turns out to be one-off stale data (e.g. this worktree predates when `infra.connections` provisioning was wired up), the fix may just be a one-time backfill/data-repair migration plus confirming the *current* provisioning flow is already correct — much smaller scope than a code fix.
