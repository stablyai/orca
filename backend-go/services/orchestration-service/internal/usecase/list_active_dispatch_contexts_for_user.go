package usecase

import (
	"context"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/common/tenant"

	"github.com/stablyai/orca-go/services/orchestration-service/internal/domain"
)

// ListActiveDispatchContextsForUser answers "which dispatch contexts are
// currently active for the caller" — CR-STORAGE-006/007's
// "agentSession.listActive" hydrate. userID comes from the authenticated
// identity, never a request field — same rule every other usecase in this
// service follows for tenantID.
//
// See specs/backlog/BACKLOG-006-dispatch-context-user-linkage-decision.md
// for why this filters dispatch_contexts.user_id directly rather than
// resolving through coordinator_runs (no RPC creates a coordinator_runs
// row yet — StartCoordinatorRun is out of scope here, tracked separately
// as TASK-TG-04-04's flagged server-side dependency).
type ListActiveDispatchContextsForUser struct {
	repo DispatchContextRepository
}

func NewListActiveDispatchContextsForUser(repo DispatchContextRepository) *ListActiveDispatchContextsForUser {
	return &ListActiveDispatchContextsForUser{repo: repo}
}

func (uc *ListActiveDispatchContextsForUser) Execute(ctx context.Context) ([]domain.DispatchContext, error) {
	tenantID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return nil, apperrors.New(apperrors.KindUnauthenticated, "ORCH_NO_TENANT", "no tenant in request context", err)
	}
	userID, ok := tenant.UserID(ctx)
	if !ok || userID == "" {
		return nil, apperrors.New(apperrors.KindUnauthenticated, "ORCH_NO_USER", "no user in request context", nil)
	}

	out, err := uc.repo.ListActiveDispatchContextsForUser(ctx, tenantID, userID)
	if err != nil {
		return nil, apperrors.New(apperrors.KindInternal, "ORCH_LIST_ACTIVE_DISPATCH_FAILED", "failed to list active dispatch contexts", err)
	}
	return out, nil
}
