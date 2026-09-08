-- Adds worktree_id to dispatch_contexts so agentSession.listActive's
-- results can be keyed onto the frontend's worktreeId-keyed
-- remoteAgentSessions slice — see
-- specs/backlog/BACKLOG-013-dispatch-context-handle-worktree-linkage.md.
-- Caller-supplied at CreateDispatchContext time (unlike user_id, which
-- comes from identity) — the server has no way to derive "which worktree"
-- on its own, same as handle/coordinator_run_id/orchestration_task_id.
ALTER TABLE orchestration.dispatch_contexts
  ADD COLUMN worktree_id TEXT NULL;

CREATE INDEX idx_dispatch_contexts_worktree ON orchestration.dispatch_contexts(tenant_id, worktree_id)
  WHERE worktree_id IS NOT NULL;
