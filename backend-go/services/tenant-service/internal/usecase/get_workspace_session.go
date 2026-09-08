package usecase

import (
	"context"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/common/tenant"
)

type GetWorkspaceSession struct {
	repo WorkspaceSessionRepository
}

func NewGetWorkspaceSession(repo WorkspaceSessionRepository) *GetWorkspaceSession {
	return &GetWorkspaceSession{repo: repo}
}

// GetWorkspaceSessionResult's Found distinguishes "never saved for this
// (user, host) pair" from a real, possibly empty-but-saved session.
type GetWorkspaceSessionResult struct {
	SessionJSON string
	Found       bool
}

func (uc *GetWorkspaceSession) Execute(ctx context.Context, userID, hostID string) (GetWorkspaceSessionResult, error) {
	companyID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return GetWorkspaceSessionResult{}, apperrors.New(apperrors.KindUnauthenticated, "TENANT_NO_TENANT", "no tenant in request context", err)
	}
	sessionJSON, found, err := uc.repo.Get(ctx, companyID, userID, hostID)
	if err != nil {
		return GetWorkspaceSessionResult{}, apperrors.New(apperrors.KindInternal, "TENANT_GET_WORKSPACE_SESSION_FAILED", "failed to load workspace session", err)
	}
	return GetWorkspaceSessionResult{SessionJSON: sessionJSON, Found: found}, nil
}
