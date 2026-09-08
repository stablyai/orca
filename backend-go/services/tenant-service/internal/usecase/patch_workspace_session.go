package usecase

import (
	"context"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/common/tenant"
)

type PatchWorkspaceSession struct {
	repo WorkspaceSessionRepository
}

func NewPatchWorkspaceSession(repo WorkspaceSessionRepository) *PatchWorkspaceSession {
	return &PatchWorkspaceSession{repo: repo}
}

type PatchWorkspaceSessionInput struct {
	UserID    string
	HostID    string
	PatchJSON string
}

// Execute forwards to WorkspaceSessionRepository.Patch, which is
// responsible for the actual read-modify-write under a lock/transaction
// (BE-SOL-STORAGE-001 §4) — this usecase has no merge logic of its own to
// decide, same "thin usecase, nothing to decide" shape as
// SetWorkspaceSession above.
func (uc *PatchWorkspaceSession) Execute(ctx context.Context, in PatchWorkspaceSessionInput) error {
	companyID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return apperrors.New(apperrors.KindUnauthenticated, "TENANT_NO_TENANT", "no tenant in request context", err)
	}
	if err := uc.repo.Patch(ctx, companyID, in.UserID, in.HostID, in.PatchJSON); err != nil {
		return apperrors.New(apperrors.KindInternal, "TENANT_PATCH_WORKSPACE_SESSION_FAILED", "failed to patch workspace session", err)
	}
	return nil
}
