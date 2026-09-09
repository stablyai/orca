package grpcclient

import (
	"context"
	"fmt"
	"strings"

	"google.golang.org/grpc"

	"github.com/stablyai/orca-go/services/automation-service/internal/usecase"

	scmintegrationv1 "github.com/stablyai/orca-go/proto/gen/go/orca/scmintegration/v1"
)

// ScmClient implements usecase.PullRequestCreator by calling
// scm-integration-service's generated ScmIntegrationServiceClient over a
// real *grpc.ClientConn — CR-AUTO-003/TASK-BE-AUTO-006, same thin-adapter
// shape as WorkflowClient (see that file's doc comment for the rationale:
// dial once in cmd/server/main.go, fake the port directly in tests).
type ScmClient struct {
	client scmintegrationv1.ScmIntegrationServiceClient
}

// NewScmClient wraps an already-dialed connection to scm-integration-service.
func NewScmClient(conn grpc.ClientConnInterface) *ScmClient {
	return &ScmClient{client: scmintegrationv1.NewScmIntegrationServiceClient(conn)}
}

// CreatePullRequest calls scm-integration-service.CreatePullRequest for
// real — provider-agnostic per AGENTS.md's "Git Provider Compatibility"
// (scm-integration-service itself owns the GitHub/GitLab/... dispatch, this
// adapter never assumes a specific provider).
func (c *ScmClient) CreatePullRequest(ctx context.Context, in usecase.CreatePullRequestInput) (usecase.CreatePullRequestOutput, error) {
	ctx, err := withTenantMetadata(ctx)
	if err != nil {
		return usecase.CreatePullRequestOutput{}, fmt.Errorf("grpcclient: scm-integration-service CreatePullRequest: %w", err)
	}
	resp, err := c.client.CreatePullRequest(ctx, &scmintegrationv1.CreatePullRequestRequest{
		TenantId:   in.TenantID,
		Provider:   toProtoScmProvider(in.Provider),
		Repo:       in.Repo,
		Title:      in.Title,
		Body:       in.Body,
		HeadBranch: in.HeadBranch,
		BaseBranch: in.BaseBranch,
		RequestId:  in.RequestID,
	})
	if err != nil {
		return usecase.CreatePullRequestOutput{}, fmt.Errorf("grpcclient: scm-integration-service CreatePullRequest: %w", err)
	}
	pr := resp.GetPullRequest()
	return usecase.CreatePullRequestOutput{URL: pr.GetUrl(), Number: pr.GetNumber()}, nil
}

// toProtoScmProvider accepts either the bare lowercase name (e.g. "github")
// or the full enum name — mirrors api-gateway/httpgateway's parseStepType
// leniency convention (usage_routes.go), applied here to keep an
// AutomationAction's config_json provider string human-writable ("github",
// not "SCM_PROVIDER_GITHUB").
func toProtoScmProvider(v string) scmintegrationv1.ScmProvider {
	name := strings.ToUpper(v)
	if !strings.HasPrefix(name, "SCM_PROVIDER_") {
		name = "SCM_PROVIDER_" + name
	}
	if n, ok := scmintegrationv1.ScmProvider_value[name]; ok {
		return scmintegrationv1.ScmProvider(n)
	}
	return scmintegrationv1.ScmProvider_SCM_PROVIDER_UNSPECIFIED
}
