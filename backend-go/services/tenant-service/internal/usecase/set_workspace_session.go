package usecase

import (
	"context"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/common/tenant"
)

type SetWorkspaceSession struct {
	repo WorkspaceSessionRepository
}

func NewSetWorkspaceSession(repo WorkspaceSessionRepository) *SetWorkspaceSession {
	return &SetWorkspaceSession{repo: repo}
}

type SetWorkspaceSessionInput struct {
	UserID      string
	HostID      string
	SessionJSON string
}

func (uc *SetWorkspaceSession) Execute(ctx context.Context, in SetWorkspaceSessionInput) error {
	companyID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return apperrors.New(apperrors.KindUnauthenticated, "TENANT_NO_TENANT", "no tenant in request context", err)
	}
	if err := uc.repo.Set(ctx, companyID, in.UserID, in.HostID, in.SessionJSON); err != nil {
		return apperrors.New(apperrors.KindInternal, "TENANT_SET_WORKSPACE_SESSION_FAILED", "failed to save workspace session", err)
	}
	return nil
}
