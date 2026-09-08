package usecase

import (
	"context"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/services/scm-integration-service/internal/domain"
)

type UpdatePullRequestParams struct {
	TenantID string
	Provider domain.ScmProvider
	Repo     string
	Number   int32
	Patch    PullRequestPatch
}

type UpdatePullRequest struct {
	credentials CredentialResolver
	providers   ProviderRegistry
}

func NewUpdatePullRequest(credentials CredentialResolver, providers ProviderRegistry) *UpdatePullRequest {
	return &UpdatePullRequest{credentials: credentials, providers: providers}
}

func (uc *UpdatePullRequest) Execute(ctx context.Context, in UpdatePullRequestParams) (domain.PullRequest, error) {
	if in.TenantID == "" {
		return domain.PullRequest{}, apperrors.New(apperrors.KindInvalidArgument, "SCM_NO_TENANT", "tenant_id is required", nil)
	}
	if in.Repo == "" {
		return domain.PullRequest{}, apperrors.New(apperrors.KindInvalidArgument, "SCM_EMPTY_REPO", "repo is required", nil)
	}
	cred, err := uc.credentials.Resolve(ctx, in.TenantID, in.Provider)
	if err != nil {
		return domain.PullRequest{}, apperrors.New(apperrors.KindInternal, "SCM_CREDENTIAL_RESOLVE_FAILED", "failed to resolve provider credential", err)
	}
	provider, err := uc.providers.Resolve(in.Provider)
	if err != nil {
		return domain.PullRequest{}, apperrors.New(apperrors.KindInvalidArgument, "SCM_PROVIDER_UNSUPPORTED", "no adapter registered for this provider", err)
	}
	pr, err := provider.UpdatePullRequest(ctx, cred, in.Repo, in.Number, in.Patch)
	if err != nil {
		return domain.PullRequest{}, apperrors.New(apperrors.KindInternal, "SCM_UPDATE_PULL_REQUEST_FAILED", "failed to update pull request", err)
	}
	return pr, nil
}
