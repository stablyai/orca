> ## ✅ RESOLVED 2026-09-08 — via a different linkage than either option below
> Neither of the 3 "decision needed" options below was taken. Instead: a
> `user_id` column was added directly to `dispatch_contexts` (migration
> `0002_dispatch_context_user_id`), populated from the authenticated
> identity at `CreateDispatchContext` time — the one RPC in this service
> with a real, working production caller (`api-gateway`'s
> `handleCreateDispatchContext` REST route). `ListActiveDispatchContextsForUser`
> filters `dispatch_contexts` directly by `(tenant_id, user_id)`, with
> `coordinator_runs` never entering the picture at all. This sidesteps the
> `StartCoordinatorRun`/task-service-grant-system dependency chain this
> entry's original options all assumed was the only path — that larger
> effort (tracked at `specs/backend-go/bugs/logic-v1/tasks/TASK-TG-04-04-real-complex-executor.md`
> and its own dependency chain) remains untouched, not duplicated or
> conflicted with. See `TASK-BE-STORAGE-007`'s updated notes for full
> verification detail. Kept below as the original analysis, since the
> underlying finding (`coordinator_runs.user_id` is unreachable — no RPC
> creates that row) is still accurate and useful context for whoever
> eventually does build `StartCoordinatorRun`.

# BACKLOG-006: `orchestration-service` has no way to map a `DispatchContext`/agent session to a user

**Origin:** `specs/backend-go/crs/v3/storage/tasks/TASK-BE-STORAGE-007-list-active-dispatch-contexts-rpc.md` (BE-SOL-STORAGE-002); downstream: `TASK-BE-STORAGE-008` (`agentSession.listActive` wscompat channel), `specs/frontend/crs/v3/storage/tasks/FE-TASK-STORAGE-012-hydrate-dev-servers-and-agent-sessions.md` (`remote-agent-sessions.ts` hydrate)
**Priority:** Medium — blocks 1 backend-go RPC + 1 frontend hydrate path, both from CR-STORAGE-006/007
**Blocked on:** A product/architecture decision — this is not a missing implementation, it's a missing field in the domain model, and closing the gap changes the RPC's actual semantics

---

## What this is

CR-STORAGE-006 wants `remote-agent-sessions.ts` (frontend) to hydrate "which
AI-agent sessions are currently running for me" from `orchestration-service`
on page load/reconnect, via a new `ListActiveDispatchContextsForUser(user_id)`
RPC. Building that RPC turned out to require something that doesn't exist.

## Why it's blocked (confirmed by reading the real domain/migration, not guessed)

Read `backend-go/services/orchestration-service/internal/domain/orchestration.go`
and `migrations/0001_init.up.sql` (matches the TDD exactly, no drift):

- `DispatchContext.Handle` (proto `assignee_handle`) is a **`KeyedAsyncQueue`
  serialization key** for the terminal/agent-worker — its own source comment
  says so verbatim. It is not, and was never intended to be, a user
  identifier.
- Neither `DispatchContext`, `OrchestrationTask`, nor `CoordinatorRun` carries
  `project_id`, `user_id`, `created_by`, or `requested_by` — only `tenant_id`
  and an opaque logical FK (`origin_task_id`, a different id space living in
  `task-service`, present only on the DAG root row). `grep` for those field
  names across the whole service (excluding tests) returns zero hits.

The only theoretical resolution path — walk `ParentID` up to the DAG root's
`OriginTaskID`, add a **new** outbound gRPC client from `orchestration-service`
to `task-service` (and likely `project-service`) to resolve that task's
`project_id` and check the calling user's membership — doesn't exist today,
and would change the RPC's real guarantee from "belongs to this user" to "any
dispatch context under a project this user is a member of." That's a
materially broader, different contract than the RPC name promises, not a
free extension of it.

## What NOT to do

Don't guess a filter (e.g. treating `assignee_handle` as if it were a user
id) just to ship something — it would silently scope the RPC wrong and leak
or hide dispatch contexts across users. `TASK-BE-STORAGE-007` deliberately
stopped here rather than touch proto/usecase/grpc/repository/`main.go` files
on a guess.

## The decision needed

Someone who owns the orchestration/task/project domain boundary needs to
decide one of:

1. **Add a real `user_id`/`requested_by` field to `CoordinatorRun`/the DAG
   root `OrchestrationTask`**, populated at `StartCoordinatorRun` time (the
   caller, `task-service`, already knows the requesting user) — the
   surgical fix, keeps the RPC's semantics exactly as named.
2. **Accept the broader "project membership" semantics** and build the
   cross-service `task-service`/`project-service` resolution path — more
   work, but may be desired anyway for other project-scoped dispatch
   queries.
3. **Descope the RPC** to "list active dispatch contexts for a
   `coordinator_run_id`" (already resolvable) and let the frontend pass one
   in explicitly instead of asking "for the current user" — smallest change,
   but pushes the "which runs are mine" question back onto the caller.

## Once decided

- `TASK-BE-STORAGE-007` implements `ListActiveDispatchContextsForUser` (or
  whatever the chosen option is actually named).
- `TASK-BE-STORAGE-008` wires it into wscompat as `agentSession.listActive`.
- `specs/frontend/.../FE-TASK-STORAGE-012-hydrate-dev-servers-and-agent-sessions.md`'s
  `remote-agent-sessions.ts` half (currently blocked) can then hydrate for
  real — its `dev-servers.ts` half is already done independently.
