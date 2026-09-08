# BACKLOG-013: `agentSession.listActive`'s dispatch contexts can't be keyed onto `remoteAgentSessions` (worktreeId vs. assigneeHandle)

**Origin:** `specs/frontend/crs/v3/storage/tasks/FE-TASK-STORAGE-012-hydrate-dev-servers-and-agent-sessions.md` (remote-agent-sessions.ts half)
**Priority:** Low-Medium — the RPC itself is real and working (`TASK-BE-STORAGE-007`/`008`, done 2026-09-08); only the frontend's specific hydrate target is blocked
**Blocked on:** No existing field links a dispatch context to a `worktreeId` — needs either a new field or a redesigned hydrate target

---

## What this is

`FE-TASK-STORAGE-012` wants `remote-agent-sessions.ts`'s
`remoteAgentSessions: Record<worktreeId, RemoteAgentSession>` slice hydrated
from `agentSession.listActive` (real, working RPC as of 2026-09-08 — see
`BACKLOG-006`, resolved). Wiring this turned out to need a mapping that
doesn't exist.

## Why it's blocked

`orchestration-service`'s `DispatchContext.assigneeHandle` (`handle` on the
wire) is documented, in the domain code's own comment, as a
`KeyedAsyncQueue` **serialization key for a terminal-hosted AI-agent
worker** — an opaque string chosen for mutual-exclusion purposes, not a
`worktreeId`. `orchestrationTaskId` is the other candidate field, but it's
a logical FK into `orchestration_tasks` (a DAG-node id space,
`orchestration-service`'s own), not task-service's `Task.id` and
definitely not a frontend `worktreeId`.

No table, proto message, or usecase anywhere in `orchestration-service`
carries a `worktreeId` today. `grep -rn "worktree" backend-go/services/orchestration-service/`
returns nothing outside comments.

## What NOT to do

Don't assume `assigneeHandle` happens to equal a `worktreeId` in practice
(e.g. because some caller today constructs it that way) and hard-code that
assumption into the frontend mapping — the domain's own doc comment
explicitly says this field means something else, and a future change to
how handles are generated would silently break the mapping with no type
error to catch it.

## The decision needed

Someone who owns the terminal-pane ↔ dispatch-context relationship needs
to pick one:

1. **Add a `worktree_id` field to `dispatch_contexts`**, populated by
   whoever calls `CreateDispatchContext` (mirrors this session's own
   `user_id` addition — same pattern, same precedent) — if the real
   caller genuinely knows the worktree at creation time.
2. **Resolve `assigneeHandle` to a worktreeId via whatever registry already
   maps terminal handles to worktrees** (if one exists in `agent/` or
   `desktop/`'s terminal-pane management) — needs confirming such a
   registry exists and is reachable from the frontend without a new
   cross-repo call.
3. **Redesign the frontend hydrate target** — instead of forcing dispatch
   contexts into the existing `worktreeId`-keyed slice, surface
   `agentSession.listActive`'s results in a new, independently-keyed UI
   section (e.g., "Active Agent Dispatches," keyed by dispatch context id)
   that doesn't need a worktree association at all.

## Once decided

- If (1): mirror `TASK-BE-STORAGE-007`'s exact migration/repository/proto
  pattern for the new column.
- If (2) or (3): implement `mapDispatchContextsToSessions`
  (`FE-TASK-STORAGE-012`'s original scope) against whichever resolution
  path is chosen.
