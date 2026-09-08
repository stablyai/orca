-- Adds user_id to dispatch_contexts so "list my active agent sessions" can
-- be answered without StartCoordinatorRun/coordinator_runs existing yet
-- (see specs/backlog/BACKLOG-006-dispatch-context-user-linkage-decision.md
-- for why coordinator_runs.user_id, the originally-proposed home for this,
-- is not reachable today: no RPC creates a coordinator_runs row at all).
-- CreateDispatchContext is a real, working RPC with a real caller
-- (api-gateway's REST route) that already resolves an authenticated
-- identity — user_id is populated from that identity, never from the
-- request body, same rule as tenant_id.
ALTER TABLE orchestration.dispatch_contexts
  ADD COLUMN user_id TEXT NULL;

CREATE INDEX idx_dispatch_contexts_user ON orchestration.dispatch_contexts(tenant_id, user_id)
  WHERE user_id IS NOT NULL;
