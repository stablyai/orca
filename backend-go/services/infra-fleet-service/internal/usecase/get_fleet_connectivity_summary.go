package usecase

import (
	"context"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/common/tenant"
	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/domain"
)

// GetFleetConnectivitySummary backs CR-STORAGE-007's poll-driven health
// summary — TASK-BE-STORAGE-006. It is a plain Postgres read (no dial) over
// every connections row scoped to the CALLER'S tenant. tenant_id/user
// scoping comes exclusively from the authenticated identity threaded
// through ctx (tenant.RequireTenantID), never from a request field — see
// BE-SOL-STORAGE-002 §5, the same rule every other "list of mine" RPC in
// this service already follows.
type GetFleetConnectivitySummary struct {
	repo FleetConnectivityRepository
}

func NewGetFleetConnectivitySummary(repo FleetConnectivityRepository) *GetFleetConnectivitySummary {
	return &GetFleetConnectivitySummary{repo: repo}
}

// Execute returns every connection scoped to the caller's tenant. The
// result is always a non-nil slice (possibly empty) — see
// ListDevServers/ListSshTargets's own "[]-not-null" convention
// (BE-SOL-001) — never nil, so callers never need a nil-check before
// ranging or JSON-marshaling.
func (uc *GetFleetConnectivitySummary) Execute(ctx context.Context) ([]domain.Connection, error) {
	tenantID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return nil, apperrors.New(apperrors.KindUnauthenticated, "INFRA_NO_TENANT", "no tenant in request context", err)
	}

	conns, err := uc.repo.ListConnectivitySummary(ctx, tenantID)
	if err != nil {
		return nil, apperrors.New(apperrors.KindInternal, "INFRA_LIST_CONNECTIVITY_SUMMARY_FAILED", "failed to list fleet connectivity summary", err)
	}
	if conns == nil {
		conns = []domain.Connection{}
	}
	return conns, nil
}
