package usecase

import (
	"context"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/common/tenant"
)

type SetClientState struct {
	repo ClientStateRepository
}

func NewSetClientState(repo ClientStateRepository) *SetClientState {
	return &SetClientState{repo: repo}
}

type SetClientStateInput struct {
	UserID    string
	Kind      ClientStateKind
	StateJSON string
}

func (uc *SetClientState) Execute(ctx context.Context, in SetClientStateInput) error {
	companyID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return apperrors.New(apperrors.KindUnauthenticated, "TENANT_NO_TENANT", "no tenant in request context", err)
	}
	column, ok := columnForKind(in.Kind)
	if !ok {
		return apperrors.New(apperrors.KindInvalidArgument, "TENANT_UNKNOWN_CLIENT_STATE_KIND", "unknown client state kind", nil)
	}
	if err := uc.repo.SetClientStateColumn(ctx, companyID, in.UserID, column, in.StateJSON); err != nil {
		return apperrors.New(apperrors.KindInternal, "TENANT_SET_CLIENT_STATE_FAILED", "failed to save client state", err)
	}
	return nil
}
