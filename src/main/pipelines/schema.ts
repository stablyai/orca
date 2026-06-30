export const PIPELINE_SCHEMA_VERSION = 2

export const PIPELINE_CREATE_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS pipeline_runs (
    id                    TEXT PRIMARY KEY,
    template_id           TEXT NOT NULL,
    repo_id               TEXT NOT NULL,
    source_branch         TEXT NOT NULL,
    target_branch         TEXT NOT NULL,
    task_source_json      TEXT NOT NULL,
    status                TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN (
        'pending', 'planning', 'dispatching', 'executing', 'reviewing',
        'merging', 'verifying', 'completed', 'failed', 'cancelled', 'interrupted'
      )),
    status_reason         TEXT,
    max_concurrent        INTEGER NOT NULL CHECK(max_concurrent >= 1),
    max_iterations        INTEGER NOT NULL CHECK(max_iterations >= 1),
    current_iteration     INTEGER NOT NULL DEFAULT 0,
    planner_agent_id      TEXT NOT NULL,
    implementer_agent_id  TEXT NOT NULL,
    reviewer_agent_id     TEXT,
    merger_agent_id       TEXT NOT NULL,
    verifier_json         TEXT,
    execution_target_type TEXT NOT NULL CHECK(execution_target_type IN ('local', 'ssh')),
    execution_target_id   TEXT,
    automation_run_id     TEXT,
    replaces_run_id       TEXT,
    recovery_report_id    TEXT UNIQUE,
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
    started_at            TEXT,
    completed_at          TEXT,
    error_json            TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_pipeline_runs_repo_status
    ON pipeline_runs(repo_id, status, created_at);
  CREATE INDEX IF NOT EXISTS idx_pipeline_runs_automation
    ON pipeline_runs(automation_run_id);

  CREATE TABLE IF NOT EXISTS pipeline_iterations (
    id                   TEXT PRIMARY KEY,
    run_id               TEXT NOT NULL,
    iteration_number     INTEGER NOT NULL CHECK(iteration_number >= 1),
    status               TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN (
        'pending', 'planning', 'executing', 'reviewing',
        'merging', 'verifying', 'completed', 'failed', 'cancelled', 'interrupted'
      )),
    planner_terminal_id  TEXT,
    planner_worktree_id  TEXT,
    coordinator_run_id   TEXT,
    planner_output_json  TEXT,
    created_at           TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
    started_at           TEXT,
    completed_at         TEXT,
    error_json           TEXT,
    UNIQUE(run_id, iteration_number)
  );

  CREATE INDEX IF NOT EXISTS idx_pipeline_iterations_run
    ON pipeline_iterations(run_id, iteration_number);

  CREATE TABLE IF NOT EXISTS pipeline_tasks (
    id                     TEXT PRIMARY KEY,
    run_id                 TEXT NOT NULL,
    iteration_id           TEXT NOT NULL,
    source_type            TEXT NOT NULL CHECK(source_type IN ('github_issue', 'manual')),
    source_id              TEXT NOT NULL,
    title                  TEXT NOT NULL,
    branch                 TEXT NOT NULL,
    status                 TEXT NOT NULL DEFAULT 'planned'
      CHECK(status IN (
        'planned', 'worktree_created', 'dispatched', 'implemented',
        'reviewed', 'no_changes', 'merged', 'skipped', 'verified',
        'failed', 'cancelled', 'interrupted'
      )),
    blocked_by_json        TEXT NOT NULL DEFAULT '[]',
    orchestration_task_id  TEXT,
    worktree_id            TEXT,
    terminal_ids_json      TEXT NOT NULL DEFAULT '[]',
    commit_shas_json       TEXT NOT NULL DEFAULT '[]',
    result_json            TEXT,
    issue_closure_json     TEXT,
    created_at             TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
    started_at             TEXT,
    completed_at           TEXT,
    error_json             TEXT,
    UNIQUE(run_id, source_type, source_id, iteration_id)
  );

  CREATE INDEX IF NOT EXISTS idx_pipeline_tasks_run_iteration
    ON pipeline_tasks(run_id, iteration_id, status);
  CREATE INDEX IF NOT EXISTS idx_pipeline_tasks_orchestration
    ON pipeline_tasks(orchestration_task_id);
  CREATE INDEX IF NOT EXISTS idx_pipeline_tasks_worktree
    ON pipeline_tasks(worktree_id);

  CREATE TABLE IF NOT EXISTS pipeline_stages (
    id               TEXT PRIMARY KEY,
    run_id           TEXT NOT NULL,
    iteration_id     TEXT,
    task_id          TEXT,
    stage            TEXT NOT NULL CHECK(stage IN (
      'task_source', 'planner', 'implement', 'review', 'merge', 'verify'
    )),
    status           TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN (
        'pending', 'running', 'completed', 'failed', 'cancelled', 'skipped', 'interrupted'
      )),
    worktree_id      TEXT,
    terminal_id      TEXT,
    started_at       TEXT,
    completed_at     TEXT,
    output_snapshot  TEXT,
    error_json       TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_pipeline_stages_run
    ON pipeline_stages(run_id, iteration_id, task_id, stage);
  CREATE INDEX IF NOT EXISTS idx_pipeline_stages_terminal
    ON pipeline_stages(terminal_id);
  CREATE INDEX IF NOT EXISTS idx_pipeline_stages_worktree
    ON pipeline_stages(worktree_id);

  CREATE TABLE IF NOT EXISTS pipeline_logs (
    id             TEXT PRIMARY KEY,
    run_id         TEXT NOT NULL,
    iteration_id   TEXT,
    task_id        TEXT,
    stage_id       TEXT,
    level          TEXT NOT NULL DEFAULT 'info' CHECK(level IN ('debug', 'info', 'warn', 'error')),
    message        TEXT NOT NULL,
    payload_json   TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_pipeline_logs_run
    ON pipeline_logs(run_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_pipeline_logs_stage
    ON pipeline_logs(stage_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_pipeline_logs_task
    ON pipeline_logs(task_id, created_at);

  CREATE TABLE IF NOT EXISTS pipeline_dynamic_context_results (
    id                 TEXT PRIMARY KEY,
    run_id             TEXT NOT NULL,
    stage_id           TEXT,
    template_id         TEXT NOT NULL,
    command             TEXT NOT NULL,
    cwd                 TEXT NOT NULL,
    exit_code           INTEGER,
    timed_out           INTEGER NOT NULL DEFAULT 0 CHECK(timed_out IN (0, 1)),
    stdout              TEXT NOT NULL DEFAULT '',
    stderr              TEXT NOT NULL DEFAULT '',
    stdout_truncated    INTEGER NOT NULL DEFAULT 0 CHECK(stdout_truncated IN (0, 1)),
    stderr_truncated    INTEGER NOT NULL DEFAULT 0 CHECK(stderr_truncated IN (0, 1)),
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at        TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_pipeline_dynamic_context_results_run
    ON pipeline_dynamic_context_results(run_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_pipeline_dynamic_context_results_stage
    ON pipeline_dynamic_context_results(stage_id, created_at);

  CREATE TABLE IF NOT EXISTS pipeline_active_run_reservations (
    id                  TEXT PRIMARY KEY,
    run_id              TEXT NOT NULL,
    repo_id             TEXT NOT NULL,
    provider_owner      TEXT NOT NULL,
    provider_repo       TEXT NOT NULL,
    pipeline_prd_label  TEXT NOT NULL,
    prd_issue_number    INTEGER NOT NULL CHECK(prd_issue_number > 0),
    status              TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'released')),
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    released_at         TEXT,
    release_reason      TEXT,
    last_seen_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_active_reservation_key
    ON pipeline_active_run_reservations(
      repo_id, provider_owner, provider_repo, prd_issue_number, pipeline_prd_label
    )
    WHERE status = 'active';
  CREATE INDEX IF NOT EXISTS idx_pipeline_active_reservation_run
    ON pipeline_active_run_reservations(run_id, status);

  CREATE TABLE IF NOT EXISTS pipeline_recovery_reports (
    id                  TEXT PRIMARY KEY,
    interrupted_run_id  TEXT NOT NULL,
    replacement_run_id  TEXT,
    repo_id             TEXT NOT NULL,
    provider_owner      TEXT NOT NULL,
    provider_repo       TEXT NOT NULL,
    prd_issue_number    INTEGER NOT NULL CHECK(prd_issue_number > 0),
    pipeline_prd_label  TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'pending_ack'
      CHECK(status IN ('pending_ack', 'acknowledged')),
    summary_json        TEXT NOT NULL,
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    acknowledged_at     TEXT
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_recovery_pending_interrupted
    ON pipeline_recovery_reports(
      repo_id, provider_owner, provider_repo, prd_issue_number,
      pipeline_prd_label, interrupted_run_id
    )
    WHERE status = 'pending_ack';
  CREATE INDEX IF NOT EXISTS idx_pipeline_recovery_prd_status
    ON pipeline_recovery_reports(
      repo_id, provider_owner, provider_repo, prd_issue_number, pipeline_prd_label, status,
      created_at
    );
`
