DROP INDEX IF EXISTS orchestration.idx_dispatch_contexts_worktree;
ALTER TABLE orchestration.dispatch_contexts
  DROP COLUMN IF EXISTS worktree_id;
