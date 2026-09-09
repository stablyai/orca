// Package postgres implements automation-service's AutomationRepository and
// AutomationRunRepository ports (defined in internal/usecase) against this
// service's own PostgreSQL database — see
// specs/backend-go/architecture/05-data-architecture.md's
// database-per-service rule: this is the ONLY package in automation-service
// that knows SQL exists.
package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/stablyai/orca-go/services/automation-service/internal/domain"
	"github.com/stablyai/orca-go/services/automation-service/internal/usecase"
)

// ── actions_json / action_results_json (de)serialization — CR-AUTO-002/TASK-BE-AUTO-003 ──

// actionRow/actionResultRow are the JSONB wire shapes actions_json/
// action_results_json store — snake_case to match automation.proto's
// AutomationAction/ActionResult field names 1:1, so a future sqlc/direct
// JSON-column read from another tool sees the same shape the proto layer
// does.
type actionRow struct {
	ID                string `json:"id"`
	Type              string `json:"type"`
	ConfigJSON        string `json:"config_json"`
	ContinueOnFailure bool   `json:"continue_on_failure"`
}

type actionResultRow struct {
	ActionID   string `json:"action_id"`
	Status     string `json:"status"`
	OutputJSON string `json:"output_json"`
	Error      string `json:"error"`
}

func marshalActions(actions []domain.AutomationAction) ([]byte, error) {
	rows := make([]actionRow, len(actions))
	for i, a := range actions {
		rows[i] = actionRow{ID: a.ID, Type: string(a.Type), ConfigJSON: a.ConfigJSON, ContinueOnFailure: a.ContinueOnFailure}
	}
	return json.Marshal(rows)
}

func unmarshalActions(raw []byte) ([]domain.AutomationAction, error) {
	var rows []actionRow
	if err := json.Unmarshal(raw, &rows); err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}
	out := make([]domain.AutomationAction, len(rows))
	for i, r := range rows {
		out[i] = domain.AutomationAction{ID: r.ID, Type: domain.AutomationActionType(r.Type), ConfigJSON: r.ConfigJSON, ContinueOnFailure: r.ContinueOnFailure}
	}
	return out, nil
}

func marshalActionResults(results []domain.ActionResult) ([]byte, error) {
	rows := make([]actionResultRow, len(results))
	for i, r := range results {
		rows[i] = actionResultRow{ActionID: r.ActionID, Status: r.Status, OutputJSON: r.OutputJSON, Error: r.Error}
	}
	return json.Marshal(rows)
}

func unmarshalActionResults(raw []byte) ([]domain.ActionResult, error) {
	var rows []actionResultRow
	if err := json.Unmarshal(raw, &rows); err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}
	out := make([]domain.ActionResult, len(rows))
	for i, r := range rows {
		out[i] = domain.ActionResult{ActionID: r.ActionID, Status: r.Status, OutputJSON: r.OutputJSON, Error: r.Error}
	}
	return out, nil
}

// AutomationRepository implements usecase.AutomationRepository against
// Postgres via pgx — hand-written SQL (see architecture/04-tech-stack.md:
// sqlc codegen is the eventual target, this scaffold hand-writes the
// equivalent queries directly to avoid a build-time dependency on the sqlc
// binary, matching usage-service's reference pattern).
type AutomationRepository struct {
	pool *pgxpool.Pool
}

func NewAutomationRepository(pool *pgxpool.Pool) *AutomationRepository {
	return &AutomationRepository{pool: pool}
}

func (r *AutomationRepository) Create(ctx context.Context, a domain.Automation) error {
	actionsJSON, err := marshalActions(a.Actions)
	if err != nil {
		return fmt.Errorf("postgres: marshal actions: %w", err)
	}
	_, err = r.pool.Exec(ctx, `
		INSERT INTO automation.automations (
			id, tenant_id, name, rrule, dtstart, step_type, step_config_json, enabled, timezone, next_run_at, created_at, updated_at,
			actions_json, max_run_history, run_timeout_seconds
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
	`, a.ID, a.TenantID, a.Name, a.RRule, a.DTStart, string(a.StepType), a.StepConfigJSON, a.Enabled, a.Timezone, nullableTime(a.NextRunAt), a.CreatedAt, a.UpdatedAt,
		actionsJSON, a.MaxRunHistory, a.RunTimeoutSeconds)
	if err != nil {
		return fmt.Errorf("postgres: insert automation: %w", err)
	}
	return nil
}

func (r *AutomationRepository) Get(ctx context.Context, tenantID, id string) (domain.Automation, error) {
	row := r.pool.QueryRow(ctx, `
		SELECT id, tenant_id, name, rrule, dtstart, step_type, step_config_json, enabled, timezone, next_run_at, created_at, updated_at,
		       actions_json, max_run_history, run_timeout_seconds, running_run_id, running_since
		FROM automation.automations
		WHERE tenant_id = $1 AND id = $2
	`, tenantID, id)

	a, err := scanAutomation(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Automation{}, fmt.Errorf("postgres: automation %s not found: %w", id, err)
	}
	if err != nil {
		return domain.Automation{}, fmt.Errorf("postgres: query automation: %w", err)
	}
	return a, nil
}

// List returns tenantID's automations, cursor-paginated by id.
func (r *AutomationRepository) List(ctx context.Context, tenantID, pageToken string, pageSize int32) ([]domain.Automation, string, error) {
	if pageSize <= 0 {
		pageSize = 50
	}
	rows, err := r.pool.Query(ctx, `
		SELECT id, tenant_id, name, rrule, dtstart, step_type, step_config_json, enabled, timezone, next_run_at, created_at, updated_at,
		       actions_json, max_run_history, run_timeout_seconds, running_run_id, running_since
		FROM automation.automations
		WHERE tenant_id = $1 AND ($2 = '' OR id > $2::uuid)
		ORDER BY id
		LIMIT $3
	`, tenantID, pageToken, pageSize)
	if err != nil {
		return nil, "", fmt.Errorf("postgres: query automations: %w", err)
	}
	defer rows.Close()

	var out []domain.Automation
	for rows.Next() {
		a, err := scanAutomation(rows)
		if err != nil {
			return nil, "", fmt.Errorf("postgres: scan automation row: %w", err)
		}
		out = append(out, a)
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("postgres: iterate automation rows: %w", err)
	}
	nextToken := ""
	if int32(len(out)) == pageSize {
		nextToken = out[len(out)-1].ID
	}
	return out, nextToken, nil
}

// Update persists a full row replace of the caller-merged Automation
// (usecase.UpdateAutomation already merged unset fields from the current
// row before calling this) — scheduling fields (next_run_at) are
// deliberately left untouched by this statement.
func (r *AutomationRepository) Update(ctx context.Context, tenantID string, a domain.Automation) error {
	actionsJSON, err := marshalActions(a.Actions)
	if err != nil {
		return fmt.Errorf("postgres: marshal actions: %w", err)
	}
	tag, err := r.pool.Exec(ctx, `
		UPDATE automation.automations
		SET name = $3, rrule = $4, step_type = $5, step_config_json = $6,
		    enabled = $7, timezone = $8, dtstart = $9, updated_at = now(),
		    actions_json = $10, max_run_history = $11, run_timeout_seconds = $12
		WHERE tenant_id = $1 AND id = $2
	`, tenantID, a.ID, a.Name, a.RRule, string(a.StepType), a.StepConfigJSON, a.Enabled, a.Timezone, a.DTStart,
		actionsJSON, a.MaxRunHistory, a.RunTimeoutSeconds)
	if err != nil {
		return fmt.Errorf("postgres: update automation: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("postgres: automation %s not found for tenant %s", a.ID, tenantID)
	}
	return nil
}

// Delete removes an automation. automation_runs.automation_id has
// ON DELETE CASCADE (migrations/0001_init.up.sql), so run rows referencing
// this automation are removed by Postgres itself — no separate cleanup step.
func (r *AutomationRepository) Delete(ctx context.Context, tenantID, id string) error {
	tag, err := r.pool.Exec(ctx, `DELETE FROM automation.automations WHERE tenant_id = $1 AND id = $2`, tenantID, id)
	if err != nil {
		return fmt.Errorf("postgres: delete automation: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("postgres: automation %s not found for tenant %s", id, tenantID)
	}
	return nil
}

// AcquireRunLock implements usecase.AutomationRepository.AcquireRunLock — a
// single conditional UPDATE (no separate SELECT+UPDATE) so the check and
// claim are atomic under concurrent callers: two racing acquires for the
// same automation can't both see "unlocked" and both succeed, since
// Postgres serializes concurrent UPDATEs to the same row.
func (r *AutomationRepository) AcquireRunLock(ctx context.Context, tenantID, automationID, runID string, ttl time.Duration) (bool, error) {
	tag, err := r.pool.Exec(ctx, `
		UPDATE automation.automations
		SET running_run_id = $1, running_since = now()
		WHERE tenant_id = $2 AND id = $3
		  AND (running_run_id IS NULL OR running_since < now() - make_interval(secs => $4))
	`, runID, tenantID, automationID, ttl.Seconds())
	if err != nil {
		return false, fmt.Errorf("postgres: acquire run lock: %w", err)
	}
	return tag.RowsAffected() > 0, nil
}

// ReleaseRunLock implements usecase.AutomationRepository.ReleaseRunLock —
// the `running_run_id = $3` guard means a lock already reclaimed by a newer
// run (past its TTL) is left alone, not clobbered by a late release from
// the run that used to hold it.
func (r *AutomationRepository) ReleaseRunLock(ctx context.Context, tenantID, automationID, runID string) error {
	_, err := r.pool.Exec(ctx, `
		UPDATE automation.automations
		SET running_run_id = NULL, running_since = NULL
		WHERE tenant_id = $1 AND id = $2 AND running_run_id = $3
	`, tenantID, automationID, runID)
	if err != nil {
		return fmt.Errorf("postgres: release run lock: %w", err)
	}
	return nil
}

// ClaimDue implements usecase.DueAutomationClaimer — see that port's doc
// comment for why the returned batch's transaction stays open across
// dispatch. The query intentionally has no tenant filter: the scheduler
// scans across every tenant on a timer, it is not a per-request caller with
// a single tenant to scope to (see automation-service.md §7's "every
// replica runs a ticker" model) — every row it returns still carries its
// own tenant_id, which RunNow scopes its own work to via context.
func (r *AutomationRepository) ClaimDue(ctx context.Context, now time.Time, limit int32) (usecase.ClaimedBatch, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("postgres: begin claim tx: %w", err)
	}

	rows, err := tx.Query(ctx, `
		SELECT id, tenant_id, name, rrule, dtstart, step_type, step_config_json, enabled, timezone, next_run_at, created_at, updated_at,
		       actions_json, max_run_history, run_timeout_seconds, running_run_id, running_since
		FROM automation.automations
		WHERE enabled = true AND next_run_at IS NOT NULL AND next_run_at <= $1
		ORDER BY next_run_at
		LIMIT $2
		FOR UPDATE SKIP LOCKED
	`, now, limit)
	if err != nil {
		_ = tx.Rollback(ctx)
		return nil, fmt.Errorf("postgres: query due automations: %w", err)
	}

	var claimed []domain.Automation
	for rows.Next() {
		a, err := scanAutomation(rows)
		if err != nil {
			rows.Close()
			_ = tx.Rollback(ctx)
			return nil, fmt.Errorf("postgres: scan due automation row: %w", err)
		}
		claimed = append(claimed, a)
	}
	rowsErr := rows.Err()
	rows.Close()
	if rowsErr != nil {
		_ = tx.Rollback(ctx)
		return nil, fmt.Errorf("postgres: iterate due automation rows: %w", rowsErr)
	}

	return &claimedBatch{tx: tx, automations: claimed}, nil
}

// claimedBatch implements usecase.ClaimedBatch by wrapping the still-open
// pgx.Tx ClaimDue began.
type claimedBatch struct {
	tx          pgx.Tx
	automations []domain.Automation
}

func (b *claimedBatch) Automations() []domain.Automation { return b.automations }

func (b *claimedBatch) Advance(ctx context.Context, automationID string, nextRunAt time.Time, hasNext bool) error {
	var next *time.Time
	if hasNext {
		next = &nextRunAt
	}
	if _, err := b.tx.Exec(ctx, `
		UPDATE automation.automations SET next_run_at = $1, updated_at = now() WHERE id = $2
	`, next, automationID); err != nil {
		return fmt.Errorf("postgres: advance next_run_at for automation %s: %w", automationID, err)
	}
	return nil
}

func (b *claimedBatch) Commit(ctx context.Context) error {
	if err := b.tx.Commit(ctx); err != nil {
		return fmt.Errorf("postgres: commit claim batch: %w", err)
	}
	return nil
}

func (b *claimedBatch) Rollback(ctx context.Context) error {
	if err := b.tx.Rollback(ctx); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
		return fmt.Errorf("postgres: rollback claim batch: %w", err)
	}
	return nil
}

func scanAutomation(row rowScanner) (domain.Automation, error) {
	var a domain.Automation
	var stepType string
	var nextRunAt *time.Time
	var actionsJSON []byte
	var runningRunID *string
	var runningSince *time.Time
	if err := row.Scan(
		&a.ID, &a.TenantID, &a.Name, &a.RRule, &a.DTStart, &stepType, &a.StepConfigJSON,
		&a.Enabled, &a.Timezone, &nextRunAt, &a.CreatedAt, &a.UpdatedAt,
		&actionsJSON, &a.MaxRunHistory, &a.RunTimeoutSeconds, &runningRunID, &runningSince,
	); err != nil {
		return domain.Automation{}, err
	}
	a.StepType = domain.StepType(stepType)
	if nextRunAt != nil {
		a.NextRunAt = *nextRunAt
	}
	actions, err := unmarshalActions(actionsJSON)
	if err != nil {
		return domain.Automation{}, fmt.Errorf("postgres: unmarshal actions_json: %w", err)
	}
	a.Actions = actions
	if runningRunID != nil {
		a.RunningRunID = *runningRunID
	}
	if runningSince != nil {
		a.RunningSince = *runningSince
	}
	return a, nil
}

// AutomationRunRepository implements usecase.AutomationRunRepository.
type AutomationRunRepository struct {
	pool *pgxpool.Pool
}

func NewAutomationRunRepository(pool *pgxpool.Pool) *AutomationRunRepository {
	return &AutomationRunRepository{pool: pool}
}

func (r *AutomationRunRepository) Create(ctx context.Context, run domain.AutomationRun) error {
	actionResultsJSON, err := marshalActionResults(run.ActionResults)
	if err != nil {
		return fmt.Errorf("postgres: marshal action_results: %w", err)
	}
	_, err = r.pool.Exec(ctx, `
		INSERT INTO automation.automation_runs (
			id, automation_id, tenant_id, request_id, status, step_type, trigger, step_config_json,
			output_json, error_message, created_at, started_at, completed_at, action_results_json
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
	`,
		run.ID, run.AutomationID, run.TenantID, run.RequestID, string(run.Status), string(run.StepType), string(run.Trigger), run.StepConfigJSON,
		nullableString(run.OutputJSON), nullableString(run.ErrorMessage), run.CreatedAt, nullableTime(run.StartedAt), nullableTime(run.CompletedAt),
		actionResultsJSON,
	)
	if err != nil {
		return fmt.Errorf("postgres: insert automation run: %w", err)
	}
	return nil
}

func (r *AutomationRunRepository) FindByRequestID(ctx context.Context, tenantID, automationID, requestID string) (domain.AutomationRun, bool, error) {
	row := r.pool.QueryRow(ctx, `
		SELECT id, automation_id, tenant_id, request_id, status, step_type, trigger, step_config_json,
		       output_json, error_message, created_at, started_at, completed_at, action_results_json
		FROM automation.automation_runs
		WHERE tenant_id = $1 AND automation_id = $2 AND request_id = $3
	`, tenantID, automationID, requestID)

	run, err := scanRun(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.AutomationRun{}, false, nil
	}
	if err != nil {
		return domain.AutomationRun{}, false, fmt.Errorf("postgres: query automation run by request_id: %w", err)
	}
	return run, true, nil
}

func (r *AutomationRunRepository) UpdateStatus(ctx context.Context, run domain.AutomationRun) error {
	actionResultsJSON, err := marshalActionResults(run.ActionResults)
	if err != nil {
		return fmt.Errorf("postgres: marshal action_results: %w", err)
	}
	tag, err := r.pool.Exec(ctx, `
		UPDATE automation.automation_runs
		SET status = $1, output_json = $2, error_message = $3, started_at = $4, completed_at = $5, action_results_json = $8
		WHERE id = $6 AND tenant_id = $7
	`, string(run.Status), nullableString(run.OutputJSON), nullableString(run.ErrorMessage),
		nullableTime(run.StartedAt), nullableTime(run.CompletedAt), run.ID, run.TenantID, actionResultsJSON)
	if err != nil {
		return fmt.Errorf("postgres: update automation run status: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("postgres: automation run %s not found for tenant %s", run.ID, run.TenantID)
	}
	return nil
}

func (r *AutomationRunRepository) ListByAutomation(ctx context.Context, tenantID, automationID, pageToken string, pageSize int32) ([]domain.AutomationRun, string, error) {
	// automationID/pageToken are legitimately empty (the Automation page's
	// initial "all runs" load passes no automationID; the first page has no
	// cursor) — automation_id and id are UUID columns, so binding "" directly
	// against them fails with "invalid input syntax for type uuid" before
	// the WHERE clause's own logic ever runs. Same `$n = '' OR col =
	// $n::uuid` guard AutomationRepository.List already uses for pageToken,
	// applied to both optional filters here.
	rows, err := r.pool.Query(ctx, `
		SELECT id, automation_id, tenant_id, request_id, status, step_type, trigger, step_config_json,
		       output_json, error_message, created_at, started_at, completed_at, action_results_json
		FROM automation.automation_runs
		WHERE tenant_id = $1
		  AND ($2 = '' OR automation_id = $2::uuid)
		  AND ($3 = '' OR id > $3::uuid)
		ORDER BY id
		LIMIT $4
	`, tenantID, automationID, pageToken, pageSize)
	if err != nil {
		return nil, "", fmt.Errorf("postgres: query automation runs: %w", err)
	}
	defer rows.Close()

	var out []domain.AutomationRun
	for rows.Next() {
		run, err := scanRun(rows)
		if err != nil {
			return nil, "", fmt.Errorf("postgres: scan automation run row: %w", err)
		}
		out = append(out, run)
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("postgres: iterate automation run rows: %w", err)
	}

	next := ""
	if int32(len(out)) == pageSize && len(out) > 0 {
		next = out[len(out)-1].ID
	}
	return out, next, nil
}

// PruneRuns implements usecase.AutomationRunRepository.PruneRuns — deletes
// automationID's runs beyond the maxRuns most recent by created_at in one
// statement (subquery-based "keep newest N" rather than a separate
// count+offset round trip).
func (r *AutomationRunRepository) PruneRuns(ctx context.Context, tenantID, automationID string, maxRuns int32) error {
	if maxRuns <= 0 {
		return nil
	}
	_, err := r.pool.Exec(ctx, `
		DELETE FROM automation.automation_runs
		WHERE tenant_id = $1 AND automation_id = $2 AND id NOT IN (
			SELECT id FROM automation.automation_runs
			WHERE tenant_id = $1 AND automation_id = $2
			ORDER BY created_at DESC
			LIMIT $3
		)
	`, tenantID, automationID, maxRuns)
	if err != nil {
		return fmt.Errorf("postgres: prune automation runs: %w", err)
	}
	return nil
}

// rowScanner abstracts over pgx.Row and pgx.Rows, which share the same
// Scan signature — lets scanRun serve both FindByRequestID and
// ListByAutomation without duplicating the column list.
type rowScanner interface {
	Scan(dest ...any) error
}

func scanRun(row rowScanner) (domain.AutomationRun, error) {
	var run domain.AutomationRun
	var status, stepType, trigger string
	var outputJSON, errorMessage *string
	var startedAt, completedAt *time.Time
	var actionResultsJSON []byte
	if err := row.Scan(
		&run.ID, &run.AutomationID, &run.TenantID, &run.RequestID, &status, &stepType, &trigger, &run.StepConfigJSON,
		&outputJSON, &errorMessage, &run.CreatedAt, &startedAt, &completedAt, &actionResultsJSON,
	); err != nil {
		return domain.AutomationRun{}, err
	}
	run.Status = domain.RunStatus(status)
	run.StepType = domain.StepType(stepType)
	run.Trigger = domain.RunTrigger(trigger)
	if outputJSON != nil {
		run.OutputJSON = *outputJSON
	}
	if errorMessage != nil {
		run.ErrorMessage = *errorMessage
	}
	if startedAt != nil {
		run.StartedAt = *startedAt
	}
	if completedAt != nil {
		run.CompletedAt = *completedAt
	}
	actionResults, err := unmarshalActionResults(actionResultsJSON)
	if err != nil {
		return domain.AutomationRun{}, fmt.Errorf("postgres: unmarshal action_results_json: %w", err)
	}
	run.ActionResults = actionResults
	return run, nil
}

func nullableTime(t time.Time) *time.Time {
	if t.IsZero() {
		return nil
	}
	return &t
}

func nullableString(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
