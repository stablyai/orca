package wscompat

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"google.golang.org/grpc"
	"google.golang.org/protobuf/types/known/emptypb"

	gitgatewayv1 "github.com/stablyai/orca-go/proto/gen/go/orca/gitgateway/v1"
	scmintegrationv1 "github.com/stablyai/orca-go/proto/gen/go/orca/scmintegration/v1"
)

// fakeScmIntegrationClient is a minimal test double for
// scmintegrationv1.ScmIntegrationServiceClient — same embed-and-override
// shape as this package's other fake gRPC clients (channels_test.go).
type fakeScmIntegrationClient struct {
	scmintegrationv1.ScmIntegrationServiceClient

	mergePullRequestFunc              func(ctx context.Context, in *scmintegrationv1.MergePullRequestRequest) (*scmintegrationv1.MergePullRequestResponse, error)
	requestPullRequestReviewersFunc   func(ctx context.Context, in *scmintegrationv1.RequestPullRequestReviewersRequest) (*scmintegrationv1.PullRequest, error)
	updateIssueFunc                   func(ctx context.Context, in *scmintegrationv1.UpdateIssueRequest) (*scmintegrationv1.Issue, error)
	getPullRequestForBranchFunc       func(ctx context.Context, in *scmintegrationv1.GetPullRequestForBranchRequest) (*scmintegrationv1.GetPullRequestForBranchResponse, error)
	resolveRepoSlugFunc               func(ctx context.Context, in *scmintegrationv1.ResolveRepoSlugRequest) (*scmintegrationv1.ResolveRepoSlugResponse, error)
	getRateLimitStatusFunc            func(ctx context.Context, in *scmintegrationv1.GetRateLimitStatusRequest) (*scmintegrationv1.GetRateLimitStatusResponse, error)
	listAccessibleProjectsFunc        func(ctx context.Context, in *scmintegrationv1.ListAccessibleProjectsRequest) (*scmintegrationv1.ListAccessibleProjectsResponse, error)
	updateProjectItemFieldFunc        func(ctx context.Context, in *scmintegrationv1.UpdateProjectItemFieldRequest) (*scmintegrationv1.ProjectItem, error)
	deleteIssueCommentBySlugFunc      func(ctx context.Context, in *scmintegrationv1.DeleteIssueCommentBySlugRequest) (*emptypb.Empty, error)
	listMergeRequestsFunc             func(ctx context.Context, in *scmintegrationv1.ListMergeRequestsRequest) (*scmintegrationv1.ListMergeRequestsResponse, error)
	resolveMergeRequestDiscussionFunc func(ctx context.Context, in *scmintegrationv1.ResolveMergeRequestDiscussionRequest) (*scmintegrationv1.MergeRequestDiscussion, error)
	getWorkItemDetailsFunc            func(ctx context.Context, in *scmintegrationv1.GetWorkItemDetailsRequest) (*scmintegrationv1.WorkItemDetailsGitLab, error)
	createPullRequestFunc             func(ctx context.Context, in *scmintegrationv1.CreatePullRequestRequest) (*scmintegrationv1.CreatePullRequestResponse, error)
	checkHostedReviewEligibilityFunc  func(ctx context.Context, in *scmintegrationv1.CheckHostedReviewEligibilityRequest) (*scmintegrationv1.HostedReviewEligibility, error)
	removePullRequestReviewersFunc    func(ctx context.Context, in *scmintegrationv1.RemovePullRequestReviewersRequest) (*scmintegrationv1.PullRequest, error)
	setPullRequestAutoMergeFunc       func(ctx context.Context, in *scmintegrationv1.SetPullRequestAutoMergeRequest) (*scmintegrationv1.PullRequest, error)
	startOAuthFlowFunc                func(ctx context.Context, in *scmintegrationv1.StartOAuthFlowRequest) (*scmintegrationv1.StartOAuthFlowResponse, error)
	revokeAuthFunc                    func(ctx context.Context, in *scmintegrationv1.RevokeAuthRequest) (*scmintegrationv1.RevokeAuthResponse, error)
	resolveProjectRefFunc             func(ctx context.Context, in *scmintegrationv1.ResolveProjectRefRequest) (*scmintegrationv1.ResolveProjectRefResponse, error)
	listProjectViewsFunc              func(ctx context.Context, in *scmintegrationv1.ListProjectViewsRequest) (*scmintegrationv1.ListProjectViewsResponse, error)
	viewProjectTableFunc              func(ctx context.Context, in *scmintegrationv1.ViewProjectTableRequest) (*scmintegrationv1.ViewProjectTableResponse, error)
	clearProjectItemFieldFunc         func(ctx context.Context, in *scmintegrationv1.ClearProjectItemFieldRequest) (*scmintegrationv1.ProjectItem, error)
	getWorkItemDetailsBySlugFunc      func(ctx context.Context, in *scmintegrationv1.GetWorkItemDetailsBySlugRequest) (*scmintegrationv1.WorkItemDetails, error)
	updateIssueBySlugFunc             func(ctx context.Context, in *scmintegrationv1.UpdateIssueBySlugRequest) (*scmintegrationv1.WorkItemDetails, error)
	updatePullRequestBySlugFunc       func(ctx context.Context, in *scmintegrationv1.UpdatePullRequestBySlugRequest) (*scmintegrationv1.WorkItemDetails, error)
	updateIssueTypeBySlugFunc         func(ctx context.Context, in *scmintegrationv1.UpdateIssueTypeBySlugRequest) (*scmintegrationv1.WorkItemDetails, error)
	listIssueTypesBySlugFunc          func(ctx context.Context, in *scmintegrationv1.ListIssueTypesBySlugRequest) (*scmintegrationv1.ListIssueTypesBySlugResponse, error)
	listAssignableUsersBySlugFunc     func(ctx context.Context, in *scmintegrationv1.ListAssignableUsersBySlugRequest) (*scmintegrationv1.ListAssignableUsersBySlugResponse, error)
	listLabelsBySlugFunc              func(ctx context.Context, in *scmintegrationv1.ListLabelsBySlugRequest) (*scmintegrationv1.ListLabelsBySlugResponse, error)
	addIssueCommentBySlugFunc         func(ctx context.Context, in *scmintegrationv1.AddIssueCommentBySlugRequest) (*scmintegrationv1.ProjectComment, error)
	updateIssueCommentBySlugFunc      func(ctx context.Context, in *scmintegrationv1.UpdateIssueCommentBySlugRequest) (*scmintegrationv1.ProjectComment, error)
	starRepositoryFunc                func(ctx context.Context, in *scmintegrationv1.StarRepositoryRequest) (*scmintegrationv1.StarRepositoryResponse, error)
	updatePullRequestFunc             func(ctx context.Context, in *scmintegrationv1.UpdatePullRequestRequest) (*scmintegrationv1.PullRequest, error)

	// credentials.* group (channels_credentials_test.go, TASK-042).
	setIntegrationCredentialFunc       func(ctx context.Context, in *scmintegrationv1.SetIntegrationCredentialRequest) (*scmintegrationv1.SetIntegrationCredentialResponse, error)
	getIntegrationCredentialStatusFunc func(ctx context.Context, in *scmintegrationv1.GetIntegrationCredentialStatusRequest) (*scmintegrationv1.GetIntegrationCredentialStatusResponse, error)
	listIntegrationCredentialsFunc     func(ctx context.Context, in *scmintegrationv1.ListIntegrationCredentialsRequest) (*scmintegrationv1.ListIntegrationCredentialsResponse, error)
}

func (f *fakeScmIntegrationClient) MergePullRequest(ctx context.Context, in *scmintegrationv1.MergePullRequestRequest, _ ...grpc.CallOption) (*scmintegrationv1.MergePullRequestResponse, error) {
	return f.mergePullRequestFunc(ctx, in)
}

func (f *fakeScmIntegrationClient) RequestPullRequestReviewers(ctx context.Context, in *scmintegrationv1.RequestPullRequestReviewersRequest, _ ...grpc.CallOption) (*scmintegrationv1.PullRequest, error) {
	return f.requestPullRequestReviewersFunc(ctx, in)
}

func (f *fakeScmIntegrationClient) UpdateIssue(ctx context.Context, in *scmintegrationv1.UpdateIssueRequest, _ ...grpc.CallOption) (*scmintegrationv1.Issue, error) {
	return f.updateIssueFunc(ctx, in)
}

func (f *fakeScmIntegrationClient) GetPullRequestForBranch(ctx context.Context, in *scmintegrationv1.GetPullRequestForBranchRequest, _ ...grpc.CallOption) (*scmintegrationv1.GetPullRequestForBranchResponse, error) {
	return f.getPullRequestForBranchFunc(ctx, in)
}

func (f *fakeScmIntegrationClient) ResolveRepoSlug(ctx context.Context, in *scmintegrationv1.ResolveRepoSlugRequest, _ ...grpc.CallOption) (*scmintegrationv1.ResolveRepoSlugResponse, error) {
	return f.resolveRepoSlugFunc(ctx, in)
}

func (f *fakeScmIntegrationClient) GetRateLimitStatus(ctx context.Context, in *scmintegrationv1.GetRateLimitStatusRequest, _ ...grpc.CallOption) (*scmintegrationv1.GetRateLimitStatusResponse, error) {
	return f.getRateLimitStatusFunc(ctx, in)
}

func (f *fakeScmIntegrationClient) ListAccessibleProjects(ctx context.Context, in *scmintegrationv1.ListAccessibleProjectsRequest, _ ...grpc.CallOption) (*scmintegrationv1.ListAccessibleProjectsResponse, error) {
	return f.listAccessibleProjectsFunc(ctx, in)
}

func (f *fakeScmIntegrationClient) UpdateProjectItemField(ctx context.Context, in *scmintegrationv1.UpdateProjectItemFieldRequest, _ ...grpc.CallOption) (*scmintegrationv1.ProjectItem, error) {
	return f.updateProjectItemFieldFunc(ctx, in)
}

func (f *fakeScmIntegrationClient) DeleteIssueCommentBySlug(ctx context.Context, in *scmintegrationv1.DeleteIssueCommentBySlugRequest, _ ...grpc.CallOption) (*emptypb.Empty, error) {
	return f.deleteIssueCommentBySlugFunc(ctx, in)
}

func (f *fakeScmIntegrationClient) ListMergeRequests(ctx context.Context, in *scmintegrationv1.ListMergeRequestsRequest, _ ...grpc.CallOption) (*scmintegrationv1.ListMergeRequestsResponse, error) {
	return f.listMergeRequestsFunc(ctx, in)
}

func (f *fakeScmIntegrationClient) ResolveMergeRequestDiscussion(ctx context.Context, in *scmintegrationv1.ResolveMergeRequestDiscussionRequest, _ ...grpc.CallOption) (*scmintegrationv1.MergeRequestDiscussion, error) {
	return f.resolveMergeRequestDiscussionFunc(ctx, in)
}

func (f *fakeScmIntegrationClient) GetWorkItemDetails(ctx context.Context, in *scmintegrationv1.GetWorkItemDetailsRequest, _ ...grpc.CallOption) (*scmintegrationv1.WorkItemDetailsGitLab, error) {
	return f.getWorkItemDetailsFunc(ctx, in)
}

func (f *fakeScmIntegrationClient) CreatePullRequest(ctx context.Context, in *scmintegrationv1.CreatePullRequestRequest, _ ...grpc.CallOption) (*scmintegrationv1.CreatePullRequestResponse, error) {
	return f.createPullRequestFunc(ctx, in)
}

func (f *fakeScmIntegrationClient) CheckHostedReviewEligibility(ctx context.Context, in *scmintegrationv1.CheckHostedReviewEligibilityRequest, _ ...grpc.CallOption) (*scmintegrationv1.HostedReviewEligibility, error) {
	return f.checkHostedReviewEligibilityFunc(ctx, in)
}

func (f *fakeScmIntegrationClient) RemovePullRequestReviewers(ctx context.Context, in *scmintegrationv1.RemovePullRequestReviewersRequest, _ ...grpc.CallOption) (*scmintegrationv1.PullRequest, error) {
	return f.removePullRequestReviewersFunc(ctx, in)
}

func (f *fakeScmIntegrationClient) SetPullRequestAutoMerge(ctx context.Context, in *scmintegrationv1.SetPullRequestAutoMergeRequest, _ ...grpc.CallOption) (*scmintegrationv1.PullRequest, error) {
	return f.setPullRequestAutoMergeFunc(ctx, in)
}

func (f *fakeScmIntegrationClient) StartOAuthFlow(ctx context.Context, in *scmintegrationv1.StartOAuthFlowRequest, _ ...grpc.CallOption) (*scmintegrationv1.StartOAuthFlowResponse, error) {
	return f.startOAuthFlowFunc(ctx, in)
}

func (f *fakeScmIntegrationClient) RevokeAuth(ctx context.Context, in *scmintegrationv1.RevokeAuthRequest, _ ...grpc.CallOption) (*scmintegrationv1.RevokeAuthResponse, error) {
	return f.revokeAuthFunc(ctx, in)
}

func (f *fakeScmIntegrationClient) SetIntegrationCredential(ctx context.Context, in *scmintegrationv1.SetIntegrationCredentialRequest, _ ...grpc.CallOption) (*scmintegrationv1.SetIntegrationCredentialResponse, error) {
	return f.setIntegrationCredentialFunc(ctx, in)
}

func (f *fakeScmIntegrationClient) GetIntegrationCredentialStatus(ctx context.Context, in *scmintegrationv1.GetIntegrationCredentialStatusRequest, _ ...grpc.CallOption) (*scmintegrationv1.GetIntegrationCredentialStatusResponse, error) {
	return f.getIntegrationCredentialStatusFunc(ctx, in)
}

func (f *fakeScmIntegrationClient) ListIntegrationCredentials(ctx context.Context, in *scmintegrationv1.ListIntegrationCredentialsRequest, _ ...grpc.CallOption) (*scmintegrationv1.ListIntegrationCredentialsResponse, error) {
	return f.listIntegrationCredentialsFunc(ctx, in)
}

func (f *fakeScmIntegrationClient) ResolveProjectRef(ctx context.Context, in *scmintegrationv1.ResolveProjectRefRequest, _ ...grpc.CallOption) (*scmintegrationv1.ResolveProjectRefResponse, error) {
	return f.resolveProjectRefFunc(ctx, in)
}

func (f *fakeScmIntegrationClient) ListProjectViews(ctx context.Context, in *scmintegrationv1.ListProjectViewsRequest, _ ...grpc.CallOption) (*scmintegrationv1.ListProjectViewsResponse, error) {
	return f.listProjectViewsFunc(ctx, in)
}

func (f *fakeScmIntegrationClient) ViewProjectTable(ctx context.Context, in *scmintegrationv1.ViewProjectTableRequest, _ ...grpc.CallOption) (*scmintegrationv1.ViewProjectTableResponse, error) {
	return f.viewProjectTableFunc(ctx, in)
}

func (f *fakeScmIntegrationClient) ClearProjectItemField(ctx context.Context, in *scmintegrationv1.ClearProjectItemFieldRequest, _ ...grpc.CallOption) (*scmintegrationv1.ProjectItem, error) {
	return f.clearProjectItemFieldFunc(ctx, in)
}

func (f *fakeScmIntegrationClient) GetWorkItemDetailsBySlug(ctx context.Context, in *scmintegrationv1.GetWorkItemDetailsBySlugRequest, _ ...grpc.CallOption) (*scmintegrationv1.WorkItemDetails, error) {
	return f.getWorkItemDetailsBySlugFunc(ctx, in)
}

func (f *fakeScmIntegrationClient) UpdateIssueBySlug(ctx context.Context, in *scmintegrationv1.UpdateIssueBySlugRequest, _ ...grpc.CallOption) (*scmintegrationv1.WorkItemDetails, error) {
	return f.updateIssueBySlugFunc(ctx, in)
}

func (f *fakeScmIntegrationClient) UpdatePullRequestBySlug(ctx context.Context, in *scmintegrationv1.UpdatePullRequestBySlugRequest, _ ...grpc.CallOption) (*scmintegrationv1.WorkItemDetails, error) {
	return f.updatePullRequestBySlugFunc(ctx, in)
}

func (f *fakeScmIntegrationClient) UpdateIssueTypeBySlug(ctx context.Context, in *scmintegrationv1.UpdateIssueTypeBySlugRequest, _ ...grpc.CallOption) (*scmintegrationv1.WorkItemDetails, error) {
	return f.updateIssueTypeBySlugFunc(ctx, in)
}

func (f *fakeScmIntegrationClient) ListIssueTypesBySlug(ctx context.Context, in *scmintegrationv1.ListIssueTypesBySlugRequest, _ ...grpc.CallOption) (*scmintegrationv1.ListIssueTypesBySlugResponse, error) {
	return f.listIssueTypesBySlugFunc(ctx, in)
}

func (f *fakeScmIntegrationClient) ListAssignableUsersBySlug(ctx context.Context, in *scmintegrationv1.ListAssignableUsersBySlugRequest, _ ...grpc.CallOption) (*scmintegrationv1.ListAssignableUsersBySlugResponse, error) {
	return f.listAssignableUsersBySlugFunc(ctx, in)
}

func (f *fakeScmIntegrationClient) ListLabelsBySlug(ctx context.Context, in *scmintegrationv1.ListLabelsBySlugRequest, _ ...grpc.CallOption) (*scmintegrationv1.ListLabelsBySlugResponse, error) {
	return f.listLabelsBySlugFunc(ctx, in)
}

func (f *fakeScmIntegrationClient) AddIssueCommentBySlug(ctx context.Context, in *scmintegrationv1.AddIssueCommentBySlugRequest, _ ...grpc.CallOption) (*scmintegrationv1.ProjectComment, error) {
	return f.addIssueCommentBySlugFunc(ctx, in)
}

func (f *fakeScmIntegrationClient) UpdateIssueCommentBySlug(ctx context.Context, in *scmintegrationv1.UpdateIssueCommentBySlugRequest, _ ...grpc.CallOption) (*scmintegrationv1.ProjectComment, error) {
	return f.updateIssueCommentBySlugFunc(ctx, in)
}

func (f *fakeScmIntegrationClient) StarRepository(ctx context.Context, in *scmintegrationv1.StarRepositoryRequest, _ ...grpc.CallOption) (*scmintegrationv1.StarRepositoryResponse, error) {
	return f.starRepositoryFunc(ctx, in)
}

func (f *fakeScmIntegrationClient) UpdatePullRequest(ctx context.Context, in *scmintegrationv1.UpdatePullRequestRequest, _ ...grpc.CallOption) (*scmintegrationv1.PullRequest, error) {
	return f.updatePullRequestFunc(ctx, in)
}

// ── github.* ──────────────────────────────────────────────────────────────

// TestGitHubCheckOrcaStarredChannel_ReturnsNull verifies the channel
// resolves to null ("unable to determine") instead of erroring — both
// frontend call sites (Landing.tsx, GeneralSupportSection.tsx) already
// treat null as a designed fallback state, not an error.
func TestGitHubCheckOrcaStarredChannel_ReturnsNull(t *testing.T) {
	r := NewRegistry()
	registerSCMChannels(r, &fakeScmIntegrationClient{}, &fakeGitGatewayClient{})

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "github.checkOrcaStarred", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != nil {
		t.Errorf("want nil (unable to determine star status), got %v", result)
	}
}

func TestGitHubStarOrcaChannel_AlwaysStarsTheOrcaRepoRegardlessOfSource(t *testing.T) {
	var gotReq *scmintegrationv1.StarRepositoryRequest
	fake := &fakeScmIntegrationClient{
		starRepositoryFunc: func(ctx context.Context, in *scmintegrationv1.StarRepositoryRequest) (*scmintegrationv1.StarRepositoryResponse, error) {
			gotReq = in
			return &scmintegrationv1.StarRepositoryResponse{Starred: true}, nil
		},
	}
	r := NewRegistry()
	registerSCMChannels(r, fake, &fakeGitGatewayClient{})

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "github.starOrca",
		argsJSON(t, map[string]any{"source": "landing-page"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != true {
		t.Errorf("want true, got %v", result)
	}
	if gotReq.GetRepo() != "getorca/orca" {
		t.Errorf("want the relayed repo to always be the Orca repo regardless of source, got %q", gotReq.GetRepo())
	}
}

func TestGitHubStarOrcaChannel_MissingSourceDoesNotFail(t *testing.T) {
	fake := &fakeScmIntegrationClient{
		starRepositoryFunc: func(ctx context.Context, in *scmintegrationv1.StarRepositoryRequest) (*scmintegrationv1.StarRepositoryResponse, error) {
			return &scmintegrationv1.StarRepositoryResponse{Starred: true}, nil
		},
	}
	r := NewRegistry()
	registerSCMChannels(r, fake, &fakeGitGatewayClient{})

	if _, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "github.starOrca", nil); err != nil {
		t.Fatalf("unexpected error with no args: %v", err)
	}
}

func TestGitHubStarOrcaChannel_RPCErrorPropagates(t *testing.T) {
	fake := &fakeScmIntegrationClient{
		starRepositoryFunc: func(ctx context.Context, in *scmintegrationv1.StarRepositoryRequest) (*scmintegrationv1.StarRepositoryResponse, error) {
			return nil, errors.New("boom")
		},
	}
	r := NewRegistry()
	registerSCMChannels(r, fake, &fakeGitGatewayClient{})

	if _, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "github.starOrca", argsJSON(t, map[string]any{})); err == nil {
		t.Fatal("want an RPC error to propagate as a channel error, not silently swallowed")
	}
}

func TestGitHubUpdatePRTitleChannel_ResolvesRepoAndUpdatesTitle(t *testing.T) {
	var gotReq *scmintegrationv1.UpdatePullRequestRequest
	fake := &fakeScmIntegrationClient{
		updatePullRequestFunc: func(ctx context.Context, in *scmintegrationv1.UpdatePullRequestRequest) (*scmintegrationv1.PullRequest, error) {
			gotReq = in
			return &scmintegrationv1.PullRequest{Number: in.GetNumber()}, nil
		},
	}
	gitClient := &fakeGitGatewayClient{
		getRemoteUrlFunc: func(ctx context.Context, in *gitgatewayv1.GetRemoteUrlRequest) (*gitgatewayv1.GetRemoteUrlResponse, error) {
			if in.GetRemoteName() == "upstream" {
				return &gitgatewayv1.GetRemoteUrlResponse{Url: "https://github.com/getorca/orca.git"}, nil
			}
			return nil, errors.New("no upstream remote")
		},
	}
	r := NewRegistry()
	registerSCMChannels(r, fake, gitClient)

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "github.updatePRTitle",
		argsJSON(t, map[string]any{"repo": "repo-id-1", "prNumber": 7, "title": "new title"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != true {
		t.Errorf("want true (frontend contract is Promise<boolean>), got %v", result)
	}
	if gotReq.GetRepo() != "getorca/orca" || gotReq.GetNumber() != 7 || gotReq.GetTitle() != "new title" {
		t.Errorf("unexpected relayed request: %+v", gotReq)
	}
}

func TestGitHubUpdatePRTitleChannel_UnresolvableRepoPropagatesAsError(t *testing.T) {
	fake := &fakeScmIntegrationClient{}
	gitClient := &fakeGitGatewayClient{
		getRemoteUrlFunc: func(ctx context.Context, in *gitgatewayv1.GetRemoteUrlRequest) (*gitgatewayv1.GetRemoteUrlResponse, error) {
			return nil, errors.New("no remote configured")
		},
	}
	r := NewRegistry()
	registerSCMChannels(r, fake, gitClient)

	if _, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "github.updatePRTitle",
		argsJSON(t, map[string]any{"repo": "repo-id-1", "prNumber": 7, "title": "new title"})); err == nil {
		t.Fatal("want an error when the repo cannot be resolved to a GitHub owner/repo")
	}
}

func TestGitHubUpdatePRTitleChannel_RPCErrorPropagates(t *testing.T) {
	fake := &fakeScmIntegrationClient{
		updatePullRequestFunc: func(ctx context.Context, in *scmintegrationv1.UpdatePullRequestRequest) (*scmintegrationv1.PullRequest, error) {
			return nil, errors.New("boom")
		},
	}
	gitClient := &fakeGitGatewayClient{
		getRemoteUrlFunc: func(ctx context.Context, in *gitgatewayv1.GetRemoteUrlRequest) (*gitgatewayv1.GetRemoteUrlResponse, error) {
			return &gitgatewayv1.GetRemoteUrlResponse{Url: "https://github.com/getorca/orca.git"}, nil
		},
	}
	r := NewRegistry()
	registerSCMChannels(r, fake, gitClient)

	if _, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "github.updatePRTitle",
		argsJSON(t, map[string]any{"repo": "repo-id-1", "prNumber": 7, "title": "new title"})); err == nil {
		t.Fatal("want an RPC error to propagate as a channel error, not silently swallowed into false")
	}
}

func TestGitHubMergePRChannel_Success(t *testing.T) {
	var gotReq *scmintegrationv1.MergePullRequestRequest
	fake := &fakeScmIntegrationClient{
		mergePullRequestFunc: func(ctx context.Context, in *scmintegrationv1.MergePullRequestRequest) (*scmintegrationv1.MergePullRequestResponse, error) {
			gotReq = in
			return &scmintegrationv1.MergePullRequestResponse{Merged: true, Sha: "abc123"}, nil
		},
	}

	r := NewRegistry()
	registerSCMChannels(r, fake, &fakeGitGatewayClient{})

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1", UserID: "user-1"}, "github.mergePR",
		argsJSON(t, map[string]any{"repo": "o/r", "number": 42, "mergeMethod": "squash"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	resp, ok := result.(*scmintegrationv1.MergePullRequestResponse)
	if !ok || !resp.GetMerged() || resp.GetSha() != "abc123" {
		t.Fatalf("unexpected result: %+v", result)
	}
	if gotReq.GetProvider() != scmintegrationv1.ScmProvider_SCM_PROVIDER_GITHUB {
		t.Errorf("expected SCM_PROVIDER_GITHUB, got %v", gotReq.GetProvider())
	}
	if gotReq.GetRepo() != "o/r" || gotReq.GetNumber() != 42 {
		t.Errorf("expected repo=o/r number=42, got repo=%s number=%d", gotReq.GetRepo(), gotReq.GetNumber())
	}
}

func TestGitHubRequestPRReviewersChannel_Success(t *testing.T) {
	var gotReq *scmintegrationv1.RequestPullRequestReviewersRequest
	fake := &fakeScmIntegrationClient{
		requestPullRequestReviewersFunc: func(ctx context.Context, in *scmintegrationv1.RequestPullRequestReviewersRequest) (*scmintegrationv1.PullRequest, error) {
			gotReq = in
			return &scmintegrationv1.PullRequest{Id: "1", Number: 42}, nil
		},
	}
	r := NewRegistry()
	registerSCMChannels(r, fake, &fakeGitGatewayClient{})

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "github.requestPRReviewers",
		argsJSON(t, map[string]any{"repo": "o/r", "number": 42, "reviewerLogins": []string{"alice"}, "teamSlugs": []string{"team-a"}}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if pr, ok := result.(*scmintegrationv1.PullRequest); !ok || pr.GetNumber() != 42 {
		t.Fatalf("unexpected result: %+v", result)
	}
	if len(gotReq.GetReviewerLogins()) != 1 || gotReq.GetReviewerLogins()[0] != "alice" {
		t.Errorf("expected reviewerLogins passed through, got %+v", gotReq.GetReviewerLogins())
	}
}

func TestGitHubPRForBranchChannel_ReturnsNilWhenNotFound(t *testing.T) {
	fake := &fakeScmIntegrationClient{
		getPullRequestForBranchFunc: func(ctx context.Context, in *scmintegrationv1.GetPullRequestForBranchRequest) (*scmintegrationv1.GetPullRequestForBranchResponse, error) {
			return &scmintegrationv1.GetPullRequestForBranchResponse{Found: false}, nil
		},
	}
	r := NewRegistry()
	registerSCMChannels(r, fake, &fakeGitGatewayClient{})

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "github.prForBranch",
		argsJSON(t, map[string]any{"repo": "o/r", "headBranch": "feature-x"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != nil {
		t.Fatalf("expected nil result when not found, got %+v", result)
	}
}

func TestGitHubPRForBranchChannel_ReturnsPRWhenFound(t *testing.T) {
	fake := &fakeScmIntegrationClient{
		getPullRequestForBranchFunc: func(ctx context.Context, in *scmintegrationv1.GetPullRequestForBranchRequest) (*scmintegrationv1.GetPullRequestForBranchResponse, error) {
			return &scmintegrationv1.GetPullRequestForBranchResponse{Found: true, PullRequest: &scmintegrationv1.PullRequest{Id: "1", Number: 7}}, nil
		},
	}
	r := NewRegistry()
	registerSCMChannels(r, fake, &fakeGitGatewayClient{})

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "github.prForBranch",
		argsJSON(t, map[string]any{"repo": "o/r", "headBranch": "feature-x"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	pr, ok := result.(*scmintegrationv1.PullRequest)
	if !ok || pr.GetNumber() != 7 {
		t.Fatalf("unexpected result: %+v", result)
	}
}

func TestGitHubUpdateIssueChannel_OmitsUnsetOptionalFields(t *testing.T) {
	var gotReq *scmintegrationv1.UpdateIssueRequest
	fake := &fakeScmIntegrationClient{
		updateIssueFunc: func(ctx context.Context, in *scmintegrationv1.UpdateIssueRequest) (*scmintegrationv1.Issue, error) {
			gotReq = in
			return &scmintegrationv1.Issue{Id: "1"}, nil
		},
	}
	r := NewRegistry()
	registerSCMChannels(r, fake, &fakeGitGatewayClient{})

	// title/body/state absent from args[0] entirely.
	_, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "github.updateIssue",
		argsJSON(t, map[string]any{"repo": "o/r", "number": 1, "addLabels": []string{"bug"}}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if gotReq.Title != nil || gotReq.Body != nil || gotReq.State != nil {
		t.Errorf("expected unset optional fields to stay nil, got title=%v body=%v state=%v", gotReq.Title, gotReq.Body, gotReq.State)
	}
	if len(gotReq.GetAddLabels()) != 1 || gotReq.GetAddLabels()[0] != "bug" {
		t.Errorf("expected addLabels passed through, got %+v", gotReq.GetAddLabels())
	}
}

func TestGitHubUpdateIssueChannel_SetsProvidedOptionalFields(t *testing.T) {
	var gotReq *scmintegrationv1.UpdateIssueRequest
	fake := &fakeScmIntegrationClient{
		updateIssueFunc: func(ctx context.Context, in *scmintegrationv1.UpdateIssueRequest) (*scmintegrationv1.Issue, error) {
			gotReq = in
			return &scmintegrationv1.Issue{Id: "1"}, nil
		},
	}
	r := NewRegistry()
	registerSCMChannels(r, fake, &fakeGitGatewayClient{})

	_, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "github.updateIssue",
		argsJSON(t, map[string]any{"repo": "o/r", "number": 1, "title": "new title"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if gotReq.Title == nil || gotReq.GetTitle() != "new title" {
		t.Errorf("expected title set to %q, got %v", "new title", gotReq.Title)
	}
}

func TestGitHubRepoSlugChannel_Success(t *testing.T) {
	fake := &fakeScmIntegrationClient{
		resolveRepoSlugFunc: func(ctx context.Context, in *scmintegrationv1.ResolveRepoSlugRequest) (*scmintegrationv1.ResolveRepoSlugResponse, error) {
			return &scmintegrationv1.ResolveRepoSlugResponse{Owner: "octocat", Name: "hello-world", Slug: "octocat/hello-world"}, nil
		},
	}
	r := NewRegistry()
	registerSCMChannels(r, fake, &fakeGitGatewayClient{})

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "github.repoSlug",
		argsJSON(t, map[string]any{"candidate": "git@github.com:octocat/hello-world.git"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	resp, ok := result.(*scmintegrationv1.ResolveRepoSlugResponse)
	if !ok || resp.GetSlug() != "octocat/hello-world" {
		t.Fatalf("unexpected result: %+v", result)
	}
}

// ── github.project.* ─────────────────────────────────────────────────────

func TestGitHubProjectListAccessibleChannel_Success(t *testing.T) {
	var gotReq *scmintegrationv1.ListAccessibleProjectsRequest
	fake := &fakeScmIntegrationClient{
		listAccessibleProjectsFunc: func(ctx context.Context, in *scmintegrationv1.ListAccessibleProjectsRequest) (*scmintegrationv1.ListAccessibleProjectsResponse, error) {
			gotReq = in
			return &scmintegrationv1.ListAccessibleProjectsResponse{Projects: []*scmintegrationv1.Project{{Slug: "acme/7"}}}, nil
		},
	}
	r := NewRegistry()
	registerSCMChannels(r, fake, &fakeGitGatewayClient{})

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "github.project.listAccessible", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	resp, ok := result.(*scmintegrationv1.ListAccessibleProjectsResponse)
	if !ok || len(resp.GetProjects()) != 1 {
		t.Fatalf("unexpected result: %+v", result)
	}
	if gotReq.GetTenantId() != "tenant-1" {
		t.Errorf("expected tenant_id passed through, got %q", gotReq.GetTenantId())
	}
}

func TestGitHubProjectUpdateItemFieldChannel_Success(t *testing.T) {
	var gotReq *scmintegrationv1.UpdateProjectItemFieldRequest
	fake := &fakeScmIntegrationClient{
		updateProjectItemFieldFunc: func(ctx context.Context, in *scmintegrationv1.UpdateProjectItemFieldRequest) (*scmintegrationv1.ProjectItem, error) {
			gotReq = in
			return &scmintegrationv1.ProjectItem{Id: "item-1"}, nil
		},
	}
	r := NewRegistry()
	registerSCMChannels(r, fake, &fakeGitGatewayClient{})

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "github.project.updateItemField",
		argsJSON(t, map[string]any{"projectSlug": "acme/7", "itemId": "item-1", "fieldId": "f1", "kind": "text", "value": "hi"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if item, ok := result.(*scmintegrationv1.ProjectItem); !ok || item.GetId() != "item-1" {
		t.Fatalf("unexpected result: %+v", result)
	}
	if gotReq.GetField().GetKind() != "text" || gotReq.GetField().GetValue() != "hi" {
		t.Errorf("unexpected field: %+v", gotReq.GetField())
	}
}

func TestGitHubProjectDeleteIssueCommentBySlugChannel_ReturnsNil(t *testing.T) {
	var gotReq *scmintegrationv1.DeleteIssueCommentBySlugRequest
	fake := &fakeScmIntegrationClient{
		deleteIssueCommentBySlugFunc: func(ctx context.Context, in *scmintegrationv1.DeleteIssueCommentBySlugRequest) (*emptypb.Empty, error) {
			gotReq = in
			return &emptypb.Empty{}, nil
		},
	}
	r := NewRegistry()
	registerSCMChannels(r, fake, &fakeGitGatewayClient{})

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "github.project.deleteIssueCommentBySlug",
		argsJSON(t, map[string]any{"itemSlug": "acme/repo#1", "commentId": "c1"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != nil {
		t.Fatalf("expected nil result, got %+v", result)
	}
	if gotReq.GetItemSlug() != "acme/repo#1" || gotReq.GetCommentId() != "c1" {
		t.Errorf("unexpected request: %+v", gotReq)
	}
}

func TestGitHubRateLimitChannelMatchesRESTContract(t *testing.T) {
	// github.rateLimit and the REST route (GET /v1/scm/rate-limit?provider=github)
	// both resolve to the identical GetRateLimitStatus RPC and return its
	// response verbatim — same regression-guard shape as
	// TestGitLabRateLimitChannelMatchesRESTContract above.
	want := &scmintegrationv1.GetRateLimitStatusResponse{Remaining: 42, Limit: 5000, ResetUnix: 9999}
	fake := &fakeScmIntegrationClient{
		getRateLimitStatusFunc: func(ctx context.Context, in *scmintegrationv1.GetRateLimitStatusRequest) (*scmintegrationv1.GetRateLimitStatusResponse, error) {
			if in.GetProvider() != scmintegrationv1.ScmProvider_SCM_PROVIDER_GITHUB {
				t.Fatalf("expected SCM_PROVIDER_GITHUB, got %v", in.GetProvider())
			}
			return want, nil
		},
	}
	r := NewRegistry()
	registerSCMChannels(r, fake, &fakeGitGatewayClient{})

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "github.rateLimit", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	direct, err := fake.GetRateLimitStatus(context.Background(), &scmintegrationv1.GetRateLimitStatusRequest{TenantId: "tenant-1", Provider: scmintegrationv1.ScmProvider_SCM_PROVIDER_GITHUB})
	if err != nil {
		t.Fatalf("unexpected error calling the RPC directly: %v", err)
	}
	if !reflect.DeepEqual(result, direct) {
		t.Fatalf("expected channel result to match a direct GetRateLimitStatus call, got %+v vs %+v", result, direct)
	}
}

func TestGitHubRemovePRReviewersChannel_Success(t *testing.T) {
	var gotReq *scmintegrationv1.RemovePullRequestReviewersRequest
	fake := &fakeScmIntegrationClient{
		removePullRequestReviewersFunc: func(ctx context.Context, in *scmintegrationv1.RemovePullRequestReviewersRequest) (*scmintegrationv1.PullRequest, error) {
			gotReq = in
			return &scmintegrationv1.PullRequest{Id: "1", Number: 42}, nil
		},
	}
	r := NewRegistry()
	registerSCMChannels(r, fake, &fakeGitGatewayClient{})

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "github.removePRReviewers",
		argsJSON(t, map[string]any{"repo": "o/r", "number": 42, "reviewerLogins": []string{"alice", "bob"}}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if pr, ok := result.(*scmintegrationv1.PullRequest); !ok || pr.GetNumber() != 42 {
		t.Fatalf("unexpected result: %+v", result)
	}
	if gotReq.GetProvider() != scmintegrationv1.ScmProvider_SCM_PROVIDER_GITHUB {
		t.Errorf("expected SCM_PROVIDER_GITHUB, got %v", gotReq.GetProvider())
	}
	if len(gotReq.GetReviewerLogins()) != 2 || gotReq.GetReviewerLogins()[1] != "bob" {
		t.Errorf("expected reviewerLogins passed through, got %+v", gotReq.GetReviewerLogins())
	}
}

func TestGitHubRemovePRReviewersChannel_PropagatesError(t *testing.T) {
	wantErr := errors.New("not a reviewer")
	fake := &fakeScmIntegrationClient{
		removePullRequestReviewersFunc: func(ctx context.Context, in *scmintegrationv1.RemovePullRequestReviewersRequest) (*scmintegrationv1.PullRequest, error) {
			return nil, wantErr
		},
	}
	r := NewRegistry()
	registerSCMChannels(r, fake, &fakeGitGatewayClient{})

	_, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "github.removePRReviewers",
		argsJSON(t, map[string]any{"repo": "o/r", "number": 42, "reviewerLogins": []string{"alice"}}))
	if !errors.Is(err, wantErr) {
		t.Fatalf("want %v, got %v", wantErr, err)
	}
}

func TestGitHubSetPRAutoMergeChannel_Success(t *testing.T) {
	var gotReq *scmintegrationv1.SetPullRequestAutoMergeRequest
	fake := &fakeScmIntegrationClient{
		setPullRequestAutoMergeFunc: func(ctx context.Context, in *scmintegrationv1.SetPullRequestAutoMergeRequest) (*scmintegrationv1.PullRequest, error) {
			gotReq = in
			return &scmintegrationv1.PullRequest{Id: "1", Number: 42}, nil
		},
	}
	r := NewRegistry()
	registerSCMChannels(r, fake, &fakeGitGatewayClient{})

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "github.setPRAutoMerge",
		argsJSON(t, map[string]any{"repo": "o/r", "number": 42, "enabled": true, "mergeMethod": "squash"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if pr, ok := result.(*scmintegrationv1.PullRequest); !ok || pr.GetNumber() != 42 {
		t.Fatalf("unexpected result: %+v", result)
	}
	if !gotReq.GetEnabled() || gotReq.GetMergeMethod() != "squash" {
		t.Errorf("expected enabled=true mergeMethod=squash, got enabled=%v mergeMethod=%s", gotReq.GetEnabled(), gotReq.GetMergeMethod())
	}
}

func TestGitHubStartAuthLoginChannel_Success(t *testing.T) {
	var gotReq *scmintegrationv1.StartOAuthFlowRequest
	fake := &fakeScmIntegrationClient{
		startOAuthFlowFunc: func(ctx context.Context, in *scmintegrationv1.StartOAuthFlowRequest) (*scmintegrationv1.StartOAuthFlowResponse, error) {
			gotReq = in
			return &scmintegrationv1.StartOAuthFlowResponse{AuthorizationUrl: "https://github.com/login/oauth/authorize", State: "opaque-state"}, nil
		},
	}
	r := NewRegistry()
	registerSCMChannels(r, fake, &fakeGitGatewayClient{})

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1", UserID: "user-1"}, "github.startAuthLogin",
		argsJSON(t, map[string]any{"redirectUri": "https://app.example.com/callback"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	resp, ok := result.(*scmintegrationv1.StartOAuthFlowResponse)
	if !ok || resp.GetState() != "opaque-state" {
		t.Fatalf("unexpected result: %+v", result)
	}
	if gotReq.GetUserId() != "user-1" || gotReq.GetRedirectUri() != "https://app.example.com/callback" {
		t.Errorf("expected userId/redirectUri passed through, got %+v", gotReq)
	}
	if gotReq.GetProvider() != scmintegrationv1.ScmProvider_SCM_PROVIDER_GITHUB {
		t.Errorf("expected SCM_PROVIDER_GITHUB, got %v", gotReq.GetProvider())
	}
}

func TestGitHubRevokeAuthChannel_Success(t *testing.T) {
	var gotReq *scmintegrationv1.RevokeAuthRequest
	fake := &fakeScmIntegrationClient{
		revokeAuthFunc: func(ctx context.Context, in *scmintegrationv1.RevokeAuthRequest) (*scmintegrationv1.RevokeAuthResponse, error) {
			gotReq = in
			return &scmintegrationv1.RevokeAuthResponse{}, nil
		},
	}
	r := NewRegistry()
	registerSCMChannels(r, fake, &fakeGitGatewayClient{})

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "github.revokeAuth", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if _, ok := result.(*scmintegrationv1.RevokeAuthResponse); !ok {
		t.Fatalf("unexpected result: %+v", result)
	}
	if gotReq.GetProvider() != scmintegrationv1.ScmProvider_SCM_PROVIDER_GITHUB {
		t.Errorf("expected SCM_PROVIDER_GITHUB, got %v", gotReq.GetProvider())
	}
}

func TestGitHubRevokeAuthChannel_PropagatesError(t *testing.T) {
	wantErr := errors.New("no stored credential")
	fake := &fakeScmIntegrationClient{
		revokeAuthFunc: func(ctx context.Context, in *scmintegrationv1.RevokeAuthRequest) (*scmintegrationv1.RevokeAuthResponse, error) {
			return nil, wantErr
		},
	}
	r := NewRegistry()
	registerSCMChannels(r, fake, &fakeGitGatewayClient{})

	_, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "github.revokeAuth", nil)
	if !errors.Is(err, wantErr) {
		t.Fatalf("want %v, got %v", wantErr, err)
	}
}

// ── github.project.* (remaining channels) ────────────────────────────────

func TestGitHubProjectResolveRefChannel_Success(t *testing.T) {
	var gotReq *scmintegrationv1.ResolveProjectRefRequest
	fake := &fakeScmIntegrationClient{
		resolveProjectRefFunc: func(ctx context.Context, in *scmintegrationv1.ResolveProjectRefRequest) (*scmintegrationv1.ResolveProjectRefResponse, error) {
			gotReq = in
			return &scmintegrationv1.ResolveProjectRefResponse{Slug: "acme/7", Project: &scmintegrationv1.Project{Id: "p1", Slug: "acme/7", Number: 7, Owner: "acme"}}, nil
		},
	}
	r := NewRegistry()
	registerSCMChannels(r, fake, &fakeGitGatewayClient{})

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "github.project.resolveRef",
		argsJSON(t, map[string]any{"owner": "acme", "number": 7}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	resp, ok := result.(*scmintegrationv1.ResolveProjectRefResponse)
	if !ok || resp.GetSlug() != "acme/7" {
		t.Fatalf("unexpected result: %+v", result)
	}
	if gotReq.GetOwner() != "acme" || gotReq.GetNumber() != 7 {
		t.Errorf("expected owner=acme number=7, got owner=%s number=%d", gotReq.GetOwner(), gotReq.GetNumber())
	}
}

func TestGitHubProjectListViewsChannel_Success(t *testing.T) {
	var gotReq *scmintegrationv1.ListProjectViewsRequest
	fake := &fakeScmIntegrationClient{
		listProjectViewsFunc: func(ctx context.Context, in *scmintegrationv1.ListProjectViewsRequest) (*scmintegrationv1.ListProjectViewsResponse, error) {
			gotReq = in
			return &scmintegrationv1.ListProjectViewsResponse{Views: []*scmintegrationv1.ProjectView{{Id: "v1", Name: "Board", Layout: "board"}}}, nil
		},
	}
	r := NewRegistry()
	registerSCMChannels(r, fake, &fakeGitGatewayClient{})

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "github.project.listViews",
		argsJSON(t, map[string]any{"projectSlug": "acme/7"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	resp, ok := result.(*scmintegrationv1.ListProjectViewsResponse)
	if !ok || len(resp.GetViews()) != 1 || resp.GetViews()[0].GetLayout() != "board" {
		t.Fatalf("unexpected result: %+v", result)
	}
	if gotReq.GetProjectSlug() != "acme/7" {
		t.Errorf("expected projectSlug=acme/7, got %q", gotReq.GetProjectSlug())
	}
}

func TestGitHubProjectViewTableChannel_Success(t *testing.T) {
	var gotReq *scmintegrationv1.ViewProjectTableRequest
	fake := &fakeScmIntegrationClient{
		viewProjectTableFunc: func(ctx context.Context, in *scmintegrationv1.ViewProjectTableRequest) (*scmintegrationv1.ViewProjectTableResponse, error) {
			gotReq = in
			return &scmintegrationv1.ViewProjectTableResponse{Items: []*scmintegrationv1.ProjectItem{{Id: "item-1"}}, NextPageToken: "next"}, nil
		},
	}
	r := NewRegistry()
	registerSCMChannels(r, fake, &fakeGitGatewayClient{})

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "github.project.viewTable",
		argsJSON(t, map[string]any{"projectSlug": "acme/7", "viewId": "v1", "pageToken": "tok", "pageSize": 25}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	resp, ok := result.(*scmintegrationv1.ViewProjectTableResponse)
	if !ok || len(resp.GetItems()) != 1 || resp.GetNextPageToken() != "next" {
		t.Fatalf("unexpected result: %+v", result)
	}
	if gotReq.GetViewId() != "v1" || gotReq.GetPageToken() != "tok" || gotReq.GetPageSize() != 25 {
		t.Errorf("request fields not mapped correctly: %+v", gotReq)
	}
}

func TestGitHubProjectClearItemFieldChannel_Success(t *testing.T) {
	var gotReq *scmintegrationv1.ClearProjectItemFieldRequest
	fake := &fakeScmIntegrationClient{
		clearProjectItemFieldFunc: func(ctx context.Context, in *scmintegrationv1.ClearProjectItemFieldRequest) (*scmintegrationv1.ProjectItem, error) {
			gotReq = in
			return &scmintegrationv1.ProjectItem{Id: "item-1"}, nil
		},
	}
	r := NewRegistry()
	registerSCMChannels(r, fake, &fakeGitGatewayClient{})

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "github.project.clearItemField",
		argsJSON(t, map[string]any{"projectSlug": "acme/7", "itemId": "item-1", "fieldId": "f1"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if item, ok := result.(*scmintegrationv1.ProjectItem); !ok || item.GetId() != "item-1" {
		t.Fatalf("unexpected result: %+v", result)
	}
	if gotReq.GetFieldId() != "f1" || gotReq.GetItemId() != "item-1" {
		t.Errorf("request fields not mapped correctly: %+v", gotReq)
	}
}

func TestGitHubProjectWorkItemDetailsBySlugChannel_Success(t *testing.T) {
	var gotReq *scmintegrationv1.GetWorkItemDetailsBySlugRequest
	fake := &fakeScmIntegrationClient{
		getWorkItemDetailsBySlugFunc: func(ctx context.Context, in *scmintegrationv1.GetWorkItemDetailsBySlugRequest) (*scmintegrationv1.WorkItemDetails, error) {
			gotReq = in
			return &scmintegrationv1.WorkItemDetails{Slug: in.GetItemSlug(), Title: "Bug"}, nil
		},
	}
	r := NewRegistry()
	registerSCMChannels(r, fake, &fakeGitGatewayClient{})

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "github.project.workItemDetailsBySlug",
		argsJSON(t, map[string]any{"itemSlug": "acme/repo#1"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	details, ok := result.(*scmintegrationv1.WorkItemDetails)
	if !ok || details.GetSlug() != "acme/repo#1" {
		t.Fatalf("unexpected result: %+v", result)
	}
	if gotReq.GetItemSlug() != "acme/repo#1" {
		t.Errorf("expected itemSlug=acme/repo#1, got %q", gotReq.GetItemSlug())
	}
}

func TestGitHubProjectUpdateIssueBySlugChannel_OmitsUnsetOptionalFields(t *testing.T) {
	var gotReq *scmintegrationv1.UpdateIssueBySlugRequest
	fake := &fakeScmIntegrationClient{
		updateIssueBySlugFunc: func(ctx context.Context, in *scmintegrationv1.UpdateIssueBySlugRequest) (*scmintegrationv1.WorkItemDetails, error) {
			gotReq = in
			return &scmintegrationv1.WorkItemDetails{Slug: in.GetItemSlug()}, nil
		},
	}
	r := NewRegistry()
	registerSCMChannels(r, fake, &fakeGitGatewayClient{})

	_, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "github.project.updateIssueBySlug",
		argsJSON(t, map[string]any{"itemSlug": "acme/repo#1", "addLabels": []string{"bug"}}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if gotReq.Title != nil || gotReq.Body != nil || gotReq.State != nil {
		t.Errorf("expected unset optional fields to stay nil, got title=%v body=%v state=%v", gotReq.Title, gotReq.Body, gotReq.State)
	}
	if len(gotReq.GetAddLabels()) != 1 || gotReq.GetAddLabels()[0] != "bug" {
		t.Errorf("expected addLabels passed through, got %+v", gotReq.GetAddLabels())
	}
}

func TestGitHubProjectUpdateIssueBySlugChannel_PropagatesError(t *testing.T) {
	wantErr := errors.New("item not found")
	fake := &fakeScmIntegrationClient{
		updateIssueBySlugFunc: func(ctx context.Context, in *scmintegrationv1.UpdateIssueBySlugRequest) (*scmintegrationv1.WorkItemDetails, error) {
			return nil, wantErr
		},
	}
	r := NewRegistry()
	registerSCMChannels(r, fake, &fakeGitGatewayClient{})

	_, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "github.project.updateIssueBySlug",
		argsJSON(t, map[string]any{"itemSlug": "acme/repo#1", "title": "new title"}))
	if !errors.Is(err, wantErr) {
		t.Fatalf("want %v, got %v", wantErr, err)
	}
}

func TestGitHubProjectUpdatePullRequestBySlugChannel_SetsProvidedOptionalFields(t *testing.T) {
	var gotReq *scmintegrationv1.UpdatePullRequestBySlugRequest
	fake := &fakeScmIntegrationClient{
		updatePullRequestBySlugFunc: func(ctx context.Context, in *scmintegrationv1.UpdatePullRequestBySlugRequest) (*scmintegrationv1.WorkItemDetails, error) {
			gotReq = in
			return &scmintegrationv1.WorkItemDetails{Slug: in.GetItemSlug()}, nil
		},
	}
	r := NewRegistry()
	registerSCMChannels(r, fake, &fakeGitGatewayClient{})

	_, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "github.project.updatePullRequestBySlug",
		argsJSON(t, map[string]any{"itemSlug": "acme/repo#2", "state": "closed"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if gotReq.State == nil || gotReq.GetState() != "closed" {
		t.Errorf("expected state set to %q, got %v", "closed", gotReq.State)
	}
	if gotReq.Title != nil || gotReq.Body != nil {
		t.Errorf("expected unset optional fields to stay nil, got title=%v body=%v", gotReq.Title, gotReq.Body)
	}
}

func TestGitHubProjectUpdateIssueTypeBySlugChannel_Success(t *testing.T) {
	var gotReq *scmintegrationv1.UpdateIssueTypeBySlugRequest
	fake := &fakeScmIntegrationClient{
		updateIssueTypeBySlugFunc: func(ctx context.Context, in *scmintegrationv1.UpdateIssueTypeBySlugRequest) (*scmintegrationv1.WorkItemDetails, error) {
			gotReq = in
			return &scmintegrationv1.WorkItemDetails{Slug: in.GetItemSlug()}, nil
		},
	}
	r := NewRegistry()
	registerSCMChannels(r, fake, &fakeGitGatewayClient{})

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "github.project.updateIssueTypeBySlug",
		argsJSON(t, map[string]any{"itemSlug": "acme/repo#1", "issueType": "Bug"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if _, ok := result.(*scmintegrationv1.WorkItemDetails); !ok {
		t.Fatalf("unexpected result: %+v", result)
	}
	if gotReq.GetIssueType() != "Bug" {
		t.Errorf("expected issueType=Bug, got %q", gotReq.GetIssueType())
	}
}

func TestGitHubProjectListIssueTypesBySlugChannel_Success(t *testing.T) {
	fake := &fakeScmIntegrationClient{
		listIssueTypesBySlugFunc: func(ctx context.Context, in *scmintegrationv1.ListIssueTypesBySlugRequest) (*scmintegrationv1.ListIssueTypesBySlugResponse, error) {
			return &scmintegrationv1.ListIssueTypesBySlugResponse{IssueTypes: []*scmintegrationv1.IssueType{{Id: "t1", Name: "Bug"}}}, nil
		},
	}
	r := NewRegistry()
	registerSCMChannels(r, fake, &fakeGitGatewayClient{})

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "github.project.listIssueTypesBySlug",
		argsJSON(t, map[string]any{"itemSlug": "acme/repo#1"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	resp, ok := result.(*scmintegrationv1.ListIssueTypesBySlugResponse)
	if !ok || len(resp.GetIssueTypes()) != 1 || resp.GetIssueTypes()[0].GetName() != "Bug" {
		t.Fatalf("unexpected result: %+v", result)
	}
}

func TestGitHubProjectListAssignableUsersBySlugChannel_Success(t *testing.T) {
	fake := &fakeScmIntegrationClient{
		listAssignableUsersBySlugFunc: func(ctx context.Context, in *scmintegrationv1.ListAssignableUsersBySlugRequest) (*scmintegrationv1.ListAssignableUsersBySlugResponse, error) {
			return &scmintegrationv1.ListAssignableUsersBySlugResponse{Users: []*scmintegrationv1.AssignableUser{{Login: "octocat", Name: "The Octocat"}}}, nil
		},
	}
	r := NewRegistry()
	registerSCMChannels(r, fake, &fakeGitGatewayClient{})

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "github.project.listAssignableUsersBySlug",
		argsJSON(t, map[string]any{"itemSlug": "acme/repo#1"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	resp, ok := result.(*scmintegrationv1.ListAssignableUsersBySlugResponse)
	if !ok || len(resp.GetUsers()) != 1 || resp.GetUsers()[0].GetLogin() != "octocat" {
		t.Fatalf("unexpected result: %+v", result)
	}
}

func TestGitHubProjectListLabelsBySlugChannel_Success(t *testing.T) {
	fake := &fakeScmIntegrationClient{
		listLabelsBySlugFunc: func(ctx context.Context, in *scmintegrationv1.ListLabelsBySlugRequest) (*scmintegrationv1.ListLabelsBySlugResponse, error) {
			return &scmintegrationv1.ListLabelsBySlugResponse{Labels: []*scmintegrationv1.Label{{Name: "bug", Color: "d73a4a"}}}, nil
		},
	}
	r := NewRegistry()
	registerSCMChannels(r, fake, &fakeGitGatewayClient{})

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "github.project.listLabelsBySlug",
		argsJSON(t, map[string]any{"itemSlug": "acme/repo#1"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	resp, ok := result.(*scmintegrationv1.ListLabelsBySlugResponse)
	if !ok || len(resp.GetLabels()) != 1 || resp.GetLabels()[0].GetName() != "bug" {
		t.Fatalf("unexpected result: %+v", result)
	}
}

func TestGitHubProjectAddIssueCommentBySlugChannel_Success(t *testing.T) {
	var gotReq *scmintegrationv1.AddIssueCommentBySlugRequest
	fake := &fakeScmIntegrationClient{
		addIssueCommentBySlugFunc: func(ctx context.Context, in *scmintegrationv1.AddIssueCommentBySlugRequest) (*scmintegrationv1.ProjectComment, error) {
			gotReq = in
			return &scmintegrationv1.ProjectComment{Id: "c1", Body: in.GetBody()}, nil
		},
	}
	r := NewRegistry()
	registerSCMChannels(r, fake, &fakeGitGatewayClient{})

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "github.project.addIssueCommentBySlug",
		argsJSON(t, map[string]any{"itemSlug": "acme/repo#1", "body": "a comment"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	comment, ok := result.(*scmintegrationv1.ProjectComment)
	if !ok || comment.GetBody() != "a comment" {
		t.Fatalf("unexpected result: %+v", result)
	}
	if gotReq.GetItemSlug() != "acme/repo#1" {
		t.Errorf("expected itemSlug=acme/repo#1, got %q", gotReq.GetItemSlug())
	}
}

func TestGitHubProjectUpdateIssueCommentBySlugChannel_Success(t *testing.T) {
	var gotReq *scmintegrationv1.UpdateIssueCommentBySlugRequest
	fake := &fakeScmIntegrationClient{
		updateIssueCommentBySlugFunc: func(ctx context.Context, in *scmintegrationv1.UpdateIssueCommentBySlugRequest) (*scmintegrationv1.ProjectComment, error) {
			gotReq = in
			return &scmintegrationv1.ProjectComment{Id: in.GetCommentId(), Body: in.GetBody()}, nil
		},
	}
	r := NewRegistry()
	registerSCMChannels(r, fake, &fakeGitGatewayClient{})

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "github.project.updateIssueCommentBySlug",
		argsJSON(t, map[string]any{"itemSlug": "acme/repo#1", "commentId": "c1", "body": "edited"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	comment, ok := result.(*scmintegrationv1.ProjectComment)
	if !ok || comment.GetId() != "c1" || comment.GetBody() != "edited" {
		t.Fatalf("unexpected result: %+v", result)
	}
	if gotReq.GetCommentId() != "c1" {
		t.Errorf("expected commentId=c1, got %q", gotReq.GetCommentId())
	}
}

// ── gitlab.* ──────────────────────────────────────────────────────────────

func TestGitLabListMRsChannel_Success(t *testing.T) {
	var gotReq *scmintegrationv1.ListMergeRequestsRequest
	fake := &fakeScmIntegrationClient{
		listMergeRequestsFunc: func(ctx context.Context, in *scmintegrationv1.ListMergeRequestsRequest) (*scmintegrationv1.ListMergeRequestsResponse, error) {
			gotReq = in
			return &scmintegrationv1.ListMergeRequestsResponse{
				MergeRequests: []*scmintegrationv1.MergeRequest{{Iid: 42, Title: "Fix bug"}},
			}, nil
		},
	}

	r := NewRegistry()
	registerSCMChannels(r, fake, &fakeGitGatewayClient{})

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1", UserID: "user-1"}, "gitlab.listMRs",
		argsJSON(t, map[string]any{"repo": "group/project", "state": "opened"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	resp, ok := result.(*scmintegrationv1.ListMergeRequestsResponse)
	if !ok || len(resp.GetMergeRequests()) != 1 || resp.GetMergeRequests()[0].GetIid() != 42 {
		t.Fatalf("unexpected result: %+v", result)
	}
	if gotReq.GetRepo() != "group/project" || gotReq.GetState() != "opened" {
		t.Errorf("expected repo=group/project state=opened, got repo=%s state=%s", gotReq.GetRepo(), gotReq.GetState())
	}
}

func TestGitLabResolveMRDiscussionChannel_Success(t *testing.T) {
	var gotReq *scmintegrationv1.ResolveMergeRequestDiscussionRequest
	fake := &fakeScmIntegrationClient{
		resolveMergeRequestDiscussionFunc: func(ctx context.Context, in *scmintegrationv1.ResolveMergeRequestDiscussionRequest) (*scmintegrationv1.MergeRequestDiscussion, error) {
			gotReq = in
			return &scmintegrationv1.MergeRequestDiscussion{Id: "disc-1", Resolved: true}, nil
		},
	}
	r := NewRegistry()
	registerSCMChannels(r, fake, &fakeGitGatewayClient{})

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "gitlab.resolveMRDiscussion",
		argsJSON(t, map[string]any{"repo": "group/project", "mergeRequestIid": 42, "discussionId": "disc-1", "resolved": true}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if disc, ok := result.(*scmintegrationv1.MergeRequestDiscussion); !ok || !disc.GetResolved() {
		t.Fatalf("unexpected result: %+v", result)
	}
	if gotReq.GetMergeRequestIid() != 42 {
		t.Errorf("expected mergeRequestIid=42, got %d", gotReq.GetMergeRequestIid())
	}
}

func TestGitLabWorkItemDetailsChannel_Success(t *testing.T) {
	fake := &fakeScmIntegrationClient{
		getWorkItemDetailsFunc: func(ctx context.Context, in *scmintegrationv1.GetWorkItemDetailsRequest) (*scmintegrationv1.WorkItemDetailsGitLab, error) {
			return &scmintegrationv1.WorkItemDetailsGitLab{Iid: in.GetIid(), Title: "Bug"}, nil
		},
	}
	r := NewRegistry()
	registerSCMChannels(r, fake, &fakeGitGatewayClient{})

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "gitlab.workItemDetails",
		argsJSON(t, map[string]any{"repo": "group/project", "iid": 42, "itemType": "issue"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if details, ok := result.(*scmintegrationv1.WorkItemDetailsGitLab); !ok || details.GetIid() != 42 {
		t.Fatalf("unexpected result: %+v", result)
	}
}

func TestGitLabRateLimitChannelMatchesRESTContract(t *testing.T) {
	// Both github.rateLimit/gitlab.rateLimit and the REST route
	// (GET /v1/scm/rate-limit?provider=...) resolve to the identical
	// GetRateLimitStatus RPC and return its response verbatim — assert the
	// channel's result equals a direct call against the same fake, the same
	// regression-guard shape scm_routes_test.go uses for the REST side.
	want := &scmintegrationv1.GetRateLimitStatusResponse{Remaining: 100, Limit: 5000, ResetUnix: 1234}
	fake := &fakeScmIntegrationClient{
		getRateLimitStatusFunc: func(ctx context.Context, in *scmintegrationv1.GetRateLimitStatusRequest) (*scmintegrationv1.GetRateLimitStatusResponse, error) {
			if in.GetProvider() != scmintegrationv1.ScmProvider_SCM_PROVIDER_GITLAB {
				t.Fatalf("expected SCM_PROVIDER_GITLAB, got %v", in.GetProvider())
			}
			return want, nil
		},
	}
	r := NewRegistry()
	registerSCMChannels(r, fake, &fakeGitGatewayClient{})

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "gitlab.rateLimit", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	direct, err := fake.GetRateLimitStatus(context.Background(), &scmintegrationv1.GetRateLimitStatusRequest{TenantId: "tenant-1", Provider: scmintegrationv1.ScmProvider_SCM_PROVIDER_GITLAB})
	if err != nil {
		t.Fatalf("unexpected error calling the RPC directly: %v", err)
	}
	if !reflect.DeepEqual(result, direct) {
		t.Fatalf("expected channel result to match a direct GetRateLimitStatus call, got %+v vs %+v", result, direct)
	}
}

// ── hostedReview.* ────────────────────────────────────────────────────────

func TestHostedReviewCreateChannel_Success(t *testing.T) {
	var gotReq *scmintegrationv1.CreatePullRequestRequest
	fake := &fakeScmIntegrationClient{
		createPullRequestFunc: func(ctx context.Context, in *scmintegrationv1.CreatePullRequestRequest) (*scmintegrationv1.CreatePullRequestResponse, error) {
			gotReq = in
			return &scmintegrationv1.CreatePullRequestResponse{PullRequest: &scmintegrationv1.PullRequest{Id: "1", Number: 1}}, nil
		},
	}
	r := NewRegistry()
	registerSCMChannels(r, fake, &fakeGitGatewayClient{})

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "hostedReview.create",
		argsJSON(t, map[string]any{"provider": "gitlab", "repo": "group/project", "title": "t", "headBranch": "h", "baseBranch": "b"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	pr, ok := result.(*scmintegrationv1.PullRequest)
	if !ok || pr.GetId() != "1" {
		t.Fatalf("expected the unwrapped PullRequest, got %+v", result)
	}
	if gotReq.GetProvider() != scmintegrationv1.ScmProvider_SCM_PROVIDER_GITLAB {
		t.Errorf("expected SCM_PROVIDER_GITLAB from parseWSProvider(\"gitlab\"), got %v", gotReq.GetProvider())
	}
}

func TestHostedReviewForBranchChannel_ReturnsNilWhenNotFound(t *testing.T) {
	fake := &fakeScmIntegrationClient{
		getPullRequestForBranchFunc: func(ctx context.Context, in *scmintegrationv1.GetPullRequestForBranchRequest) (*scmintegrationv1.GetPullRequestForBranchResponse, error) {
			return &scmintegrationv1.GetPullRequestForBranchResponse{Found: false}, nil
		},
	}
	r := NewRegistry()
	registerSCMChannels(r, fake, &fakeGitGatewayClient{})

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1", UserID: "user-1"}, "hostedReview.forBranch",
		argsJSON(t, map[string]any{"provider": "github", "repo": "o/r", "headBranch": "feature-x"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != nil {
		t.Fatalf("expected nil result when not found, got %+v", result)
	}
}

func TestHostedReviewGetCreationEligibilityChannel_Success(t *testing.T) {
	var gotReq *scmintegrationv1.CheckHostedReviewEligibilityRequest
	fake := &fakeScmIntegrationClient{
		checkHostedReviewEligibilityFunc: func(ctx context.Context, in *scmintegrationv1.CheckHostedReviewEligibilityRequest) (*scmintegrationv1.HostedReviewEligibility, error) {
			gotReq = in
			return &scmintegrationv1.HostedReviewEligibility{Eligible: true}, nil
		},
	}

	r := NewRegistry()
	registerSCMChannels(r, fake, &fakeGitGatewayClient{})

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1", UserID: "user-1"}, "hostedReview.getCreationEligibility",
		argsJSON(t, map[string]any{"provider": "gitlab", "repo": "group/project", "headBranch": "feature-x", "baseBranch": "main"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	resp, ok := result.(*scmintegrationv1.HostedReviewEligibility)
	if !ok || !resp.GetEligible() {
		t.Fatalf("unexpected result: %+v", result)
	}
	if gotReq.GetProvider() != scmintegrationv1.ScmProvider_SCM_PROVIDER_GITLAB {
		t.Errorf("expected SCM_PROVIDER_GITLAB from parseWSProvider(\"gitlab\"), got %v", gotReq.GetProvider())
	}
}

func TestParseWSProvider_UnknownStringIsUnspecified(t *testing.T) {
	if got := parseWSProvider("not-a-real-provider"); got != scmintegrationv1.ScmProvider_SCM_PROVIDER_UNSPECIFIED {
		t.Errorf("expected SCM_PROVIDER_UNSPECIFIED for an unknown string, got %v", got)
	}
}
