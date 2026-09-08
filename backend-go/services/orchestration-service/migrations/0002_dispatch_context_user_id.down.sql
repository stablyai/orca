DROP INDEX IF EXISTS orchestration.idx_dispatch_contexts_user;
ALTER TABLE orchestration.dispatch_contexts
  DROP COLUMN IF EXISTS user_id;
