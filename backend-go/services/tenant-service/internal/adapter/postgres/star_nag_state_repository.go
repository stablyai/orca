package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/stablyai/orca-go/services/tenant-service/internal/domain"
)

// StarNagStateRepository implements usecase.StarNagStateRepository against
// tenant.star_nag_state — 1:1 with a user, logical FK to auth-service, same
// isolation rule as UserProfileRepository (a row from another company
// resolves as not-found, tenant-service.md §9).
type StarNagStateRepository struct {
	pool *pgxpool.Pool
}

func NewStarNagStateRepository(pool *pgxpool.Pool) *StarNagStateRepository {
	return &StarNagStateRepository{pool: pool}
}

func (r *StarNagStateRepository) GetOrCreate(ctx context.Context, companyID, userID string) (domain.StarNagState, error) {
	state, found, err := r.get(ctx, companyID, userID)
	if err != nil {
		return domain.StarNagState{}, err
	}
	if found {
		return state, nil
	}
	def := domain.NewDefaultStarNagState(userID, companyID)
	if err := r.Save(ctx, def); err != nil {
		return domain.StarNagState{}, err
	}
	return def, nil
}

func (r *StarNagStateRepository) get(ctx context.Context, companyID, userID string) (domain.StarNagState, bool, error) {
	row := r.pool.QueryRow(ctx, `
		SELECT user_id, company_id, baseline_agents, app_version, next_threshold,
		       completed, deferred_until, agent_value_moment_app_version,
		       active_prompt, updated_at
		FROM tenant.star_nag_state
		WHERE user_id = $1 AND company_id = $2
	`, userID, companyID)

	var s domain.StarNagState
	var activePromptJSON []byte
	if err := row.Scan(&s.UserID, &s.CompanyID, &s.BaselineAgents, &s.AppVersion, &s.NextThreshold,
		&s.Completed, &s.DeferredUntil, &s.AgentValueMomentAppVersion, &activePromptJSON, &s.UpdatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.StarNagState{}, false, nil
		}
		return domain.StarNagState{}, false, fmt.Errorf("postgres: query star nag state: %w", err)
	}
	if len(activePromptJSON) > 0 {
		var p domain.ActiveStarNagPrompt
		if err := json.Unmarshal(activePromptJSON, &p); err != nil {
			return domain.StarNagState{}, false, fmt.Errorf("postgres: unmarshal active_prompt: %w", err)
		}
		s.ActivePrompt = &p
	}
	return s, true, nil
}

// Save upserts every mutable column, keyed on (user_id, company_id).
func (r *StarNagStateRepository) Save(ctx context.Context, s domain.StarNagState) error {
	var activePromptJSON []byte
	if s.ActivePrompt != nil {
		b, err := json.Marshal(s.ActivePrompt)
		if err != nil {
			return fmt.Errorf("postgres: marshal active_prompt: %w", err)
		}
		activePromptJSON = b
	}

	_, err := r.pool.Exec(ctx, `
		INSERT INTO tenant.star_nag_state
			(user_id, company_id, baseline_agents, app_version, next_threshold,
			 completed, deferred_until, agent_value_moment_app_version, active_prompt, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
		ON CONFLICT (user_id) DO UPDATE SET
			company_id                     = EXCLUDED.company_id,
			baseline_agents                = EXCLUDED.baseline_agents,
			app_version                    = EXCLUDED.app_version,
			next_threshold                 = EXCLUDED.next_threshold,
			completed                      = EXCLUDED.completed,
			deferred_until                 = EXCLUDED.deferred_until,
			agent_value_moment_app_version = EXCLUDED.agent_value_moment_app_version,
			active_prompt                  = EXCLUDED.active_prompt,
			updated_at                     = now()
	`, s.UserID, s.CompanyID, s.BaselineAgents, s.AppVersion, s.NextThreshold,
		s.Completed, s.DeferredUntil, s.AgentValueMomentAppVersion, activePromptJSON)
	if err != nil {
		return fmt.Errorf("postgres: upsert star nag state: %w", err)
	}
	return nil
}
