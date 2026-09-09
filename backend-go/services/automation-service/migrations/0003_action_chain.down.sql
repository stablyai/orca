ALTER TABLE automation.automation_runs
    DROP COLUMN action_results_json;

ALTER TABLE automation.automations
    DROP COLUMN running_since,
    DROP COLUMN running_run_id,
    DROP COLUMN run_timeout_seconds,
    DROP COLUMN max_run_history,
    DROP COLUMN actions_json;
