package grpcclient

import (
	"context"
	"errors"
	"testing"

	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"

	"github.com/stablyai/orca-go/common/grpcmw"
	"github.com/stablyai/orca-go/common/tenant"
	"github.com/stablyai/orca-go/services/automation-service/internal/usecase"

	scmintegrationv1 "github.com/stablyai/orca-go/proto/gen/go/orca/scmintegration/v1"
)

// fakeScmIntegrationServiceClient — same embed-and-override pattern as
// fakeWorkflowServiceClient (workflow_client_test.go's doc comment).
type fakeScmIntegrationServiceClient struct {
	scmintegrationv1.ScmIntegrationServiceClient
	createPullRequestFunc func(ctx context.Context, in *scmintegrationv1.CreatePullRequestRequest, opts ...grpc.CallOption) (*scmintegrationv1.CreatePullRequestResponse, error)
}

func (f *fakeScmIntegrationServiceClient) CreatePullRequest(ctx context.Context, in *scmintegrationv1.CreatePullRequestRequest, opts ...grpc.CallOption) (*scmintegrationv1.CreatePullRequestResponse, error) {
	return f.createPullRequestFunc(ctx, in, opts...)
}

// TestScmClient_CreatePullRequest_ForwardsTenantIDAsOutgoingMetadata —
// CR-AUTO-003/TASK-BE-AUTO-006, same regression class WorkflowClient's own
// forwarding test guards against (see that test's doc comment): a
// service-to-service call must forward tenant ID via outgoing metadata,
// not just the wire request field, since scm-integration-service's own
// tenant.RequireTenantID(ctx) is fed by its inbound interceptor, not by
// reading CreatePullRequestRequest.TenantId itself.
func TestScmClient_CreatePullRequest_ForwardsTenantIDAsOutgoingMetadata(t *testing.T) {
	var gotMD metadata.MD
	fake := &fakeScmIntegrationServiceClient{
		createPullRequestFunc: func(ctx context.Context, in *scmintegrationv1.CreatePullRequestRequest, _ ...grpc.CallOption) (*scmintegrationv1.CreatePullRequestResponse, error) {
			gotMD, _ = metadata.FromOutgoingContext(ctx)
			return &scmintegrationv1.CreatePullRequestResponse{PullRequest: &scmintegrationv1.PullRequest{Url: "https://example.com/pr/1", Number: 1}}, nil
		},
	}
	client := &ScmClient{client: fake}
	ctx := tenant.WithTenantID(context.Background(), "tenant-1")

	out, err := client.CreatePullRequest(ctx, usecase.CreatePullRequestInput{
		TenantID: "tenant-1", Provider: "github", Repo: "acme/widgets", Title: "x",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.URL != "https://example.com/pr/1" || out.Number != 1 {
		t.Errorf("unexpected output: %+v", out)
	}

	got := gotMD.Get(grpcmw.MetadataTenantID)
	if len(got) != 1 || got[0] != "tenant-1" {
		t.Fatalf("expected outgoing metadata %q=%q, got %v", grpcmw.MetadataTenantID, "tenant-1", got)
	}
}

func TestScmClient_CreatePullRequest_NoTenantInContext_ReturnsErrorWithoutCallingClient(t *testing.T) {
	called := false
	fake := &fakeScmIntegrationServiceClient{
		createPullRequestFunc: func(ctx context.Context, in *scmintegrationv1.CreatePullRequestRequest, _ ...grpc.CallOption) (*scmintegrationv1.CreatePullRequestResponse, error) {
			called = true
			return &scmintegrationv1.CreatePullRequestResponse{}, nil
		},
	}
	client := &ScmClient{client: fake}

	_, err := client.CreatePullRequest(context.Background(), usecase.CreatePullRequestInput{Provider: "github"})
	if err == nil {
		t.Fatal("expected an error when no tenant is present on ctx")
	}
	if called {
		t.Error("expected the underlying gRPC client to never be called without a tenant in context")
	}
}

func TestScmClient_CreatePullRequest_PropagatesClientError(t *testing.T) {
	wantErr := errors.New("boom")
	fake := &fakeScmIntegrationServiceClient{
		createPullRequestFunc: func(ctx context.Context, in *scmintegrationv1.CreatePullRequestRequest, _ ...grpc.CallOption) (*scmintegrationv1.CreatePullRequestResponse, error) {
			return nil, wantErr
		},
	}
	client := &ScmClient{client: fake}
	ctx := tenant.WithTenantID(context.Background(), "tenant-1")

	_, err := client.CreatePullRequest(ctx, usecase.CreatePullRequestInput{Provider: "github"})
	if err == nil {
		t.Fatal("expected the underlying client error to propagate")
	}
}

func TestToProtoScmProvider_AcceptsBareLowercaseName(t *testing.T) {
	cases := map[string]scmintegrationv1.ScmProvider{
		"github":              scmintegrationv1.ScmProvider_SCM_PROVIDER_GITHUB,
		"gitlab":              scmintegrationv1.ScmProvider_SCM_PROVIDER_GITLAB,
		"SCM_PROVIDER_GITHUB": scmintegrationv1.ScmProvider_SCM_PROVIDER_GITHUB,
		"nonsense":            scmintegrationv1.ScmProvider_SCM_PROVIDER_UNSPECIFIED,
		"":                    scmintegrationv1.ScmProvider_SCM_PROVIDER_UNSPECIFIED,
	}
	for in, want := range cases {
		if got := toProtoScmProvider(in); got != want {
			t.Errorf("toProtoScmProvider(%q) = %v, want %v", in, got, want)
		}
	}
}
