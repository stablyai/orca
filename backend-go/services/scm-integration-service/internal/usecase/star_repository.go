package usecase

import (
	"context"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/services/scm-integration-service/internal/domain"
)

type StarRepositoryParams struct {
	TenantID string
	Provider domain.ScmProvider
	Repo     string
}

type StarRepository struct {
	credentials CredentialResolver
	providers   ProviderRegistry
}

func NewStarRepository(credentials CredentialResolver, providers ProviderRegistry) *StarRepository {
	return &StarRepository{credentials: credentials, providers: providers}
}

func (uc *StarRepository) Execute(ctx context.Context, in StarRepositoryParams) (bool, error) {
	if in.TenantID == "" {
		return false, apperrors.New(apperrors.KindInvalidArgument, "SCM_NO_TENANT", "tenant_id is required", nil)
	}
	if in.Repo == "" {
		return false, apperrors.New(apperrors.KindInvalidArgument, "SCM_EMPTY_REPO", "repo is required", nil)
	}
	cred, err := uc.credentials.Resolve(ctx, in.TenantID, in.Provider)
	if err != nil {
		return false, apperrors.New(apperrors.KindInternal, "SCM_CREDENTIAL_RESOLVE_FAILED", "failed to resolve provider credential", err)
	}
	provider, err := uc.providers.Resolve(in.Provider)
	if err != nil {
		return false, apperrors.New(apperrors.KindInvalidArgument, "SCM_PROVIDER_UNSUPPORTED", "no adapter registered for this provider", err)
	}
	starred, err := provider.StarRepository(ctx, cred, in.Repo)
	if err != nil {
		return false, apperrors.New(apperrors.KindInternal, "SCM_STAR_REPOSITORY_FAILED", "failed to star repository", err)
	}
	return starred, nil
}
