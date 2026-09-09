-- CR-AUTO-002/TASK-BE-AUTO-003: action chain (repeated AutomationAction),
-- and CR-AUTO-007/TASK-BE-AUTO-010/011's retention/timeout/concurrency
-- columns — gộp cùng 1 migration per README's "Lưu ý migration" (cả 2
-- track đều ALTER automations/automation_runs, tránh 2 file rời gần nhau).
--
-- actions_json/action_results_json are JSONB, not a child table — matches
-- the existing opaque-JSON-blob convention step_config_json already used
-- for step config (see automation.proto's AutomationAction.config_json doc
-- comment). Empty array default so a legacy automation (actions never
-- populated) reads back as [] rather than NULL — usecase.resolveActions
-- treats [] the same as "not populated" (falls back to step_type).
ALTER TABLE automation.automations
    ADD COLUMN actions_json JSONB NOT NULL DEFAULT '[]',
    ADD COLUMN max_run_history INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN run_timeout_seconds INTEGER NOT NULL DEFAULT 0,
    -- running_run_id/running_since — TASK-BE-AUTO-011's concurrency guard.
    -- NULL running_run_id = not currently running. running_since backs the
    -- self-releasing TTL (a crash that never clears running_run_id must not
    -- lock an automation out forever) — see ExecuteAutomationChain's
    -- acquireRunLock/releaseRunLock.
    ADD COLUMN running_run_id UUID,
    ADD COLUMN running_since TIMESTAMPTZ;

ALTER TABLE automation.automation_runs
    ADD COLUMN action_results_json JSONB NOT NULL DEFAULT '[]';
