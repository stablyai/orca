// Package grpc implements the generated scmintegrationv1.ScmIntegrationServiceServer
// interface by translating wire messages to/from usecase calls — no
// business logic here, per
// specs/backend-go/architecture/03-clean-architecture-guidelines.md's
// inbound-adapter contract.
package grpc

import (
	"context"
	"time"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/services/scm-integration-service/internal/domain"
	"github.com/stablyai/orca-go/services/scm-integration-service/internal/usecase"

	"google.golang.org/protobuf/types/known/emptypb"

	scmintegrationv1 "github.com/stablyai/orca-go/proto/gen/go/orca/scmintegration/v1"
)

// Server implements scmintegrationv1.UnimplementedScmIntegrationServiceServer.
type Server struct {
	scmintegrationv1.UnimplementedScmIntegrationServiceServer

	listIssues         *usecase.ListIssues
	createPullRequest  *usecase.CreatePullRequest
	listPullRequests   *usecase.ListPullRequests
	listWorkItems      *usecase.ListWorkItems
	getRateLimitStatus *usecase.GetRateLimitStatus
	getAuthStatus      *usecase.GetAuthStatus
	startOAuthFlow     *usecase.StartOAuthFlow
	completeOAuthFlow  *usecase.CompleteOAuthFlow
	revokeAuth         *usecase.RevokeAuth

	// SOL-012 shape 1/2 — GitHub PR/issue mutations + repo/branch resolution
	// (TASK-076).
	mergePullRequest            *usecase.MergePullRequest
	requestPullRequestReviewers *usecase.RequestPullRequestReviewers
	removePullRequestReviewers  *usecase.RemovePullRequestReviewers
	setPullRequestAutoMerge     *usecase.SetPullRequestAutoMerge
	updateIssue                 *usecase.UpdateIssue
	updatePullRequest           *usecase.UpdatePullRequest
	starRepository              *usecase.StarRepository
	getPullRequestForBranch     *usecase.GetPullRequestForBranch
	resolveRepoSlug             *usecase.ResolveRepoSlug

	// SOL-012 shape 3 — GitHub Projects v2 (TASK-079).
	listAccessibleProjects    *usecase.ListAccessibleProjects
	resolveProjectRef         *usecase.ResolveProjectRef
	listProjectViews          *usecase.ListProjectViews
	viewProjectTable          *usecase.ViewProjectTable
	updateProjectItemField    *usecase.UpdateProjectItemField
	clearProjectItemField     *usecase.ClearProjectItemField
	getWorkItemDetailsBySlug  *usecase.GetWorkItemDetailsBySlug
	updateIssueBySlug         *usecase.UpdateIssueBySlug
	updatePullRequestBySlug   *usecase.UpdatePullRequestBySlug
	updateIssueTypeBySlug     *usecase.UpdateIssueTypeBySlug
	listIssueTypesBySlug      *usecase.ListIssueTypesBySlug
	listAssignableUsersBySlug *usecase.ListAssignableUsersBySlug
	listLabelsBySlug          *usecase.ListLabelsBySlug
	addIssueCommentBySlug     *usecase.AddIssueCommentBySlug
	updateIssueCommentBySlug  *usecase.UpdateIssueCommentBySlug
	deleteIssueCommentBySlug  *usecase.DeleteIssueCommentBySlug

	// SOL-013 — GitLab-specific (TASK-084).
	listMergeRequests             *usecase.ListMergeRequests
	resolveMergeRequestDiscussion *usecase.ResolveMergeRequestDiscussion
	getWorkItemDetails            *usecase.GetWorkItemDetails

	// SOL-014 — hostedReview.getCreationEligibility (TASK-088).
	checkHostedReviewEligibility   *usecase.CheckHostedReviewEligibility
	setIntegrationCredential       *usecase.SetIntegrationCredential
	getIntegrationCredentialStatus *usecase.GetIntegrationCredentialStatus
	listIntegrationCredentials     *usecase.ListIntegrationCredentials
}

func New(
	listIssues *usecase.ListIssues,
	createPullRequest *usecase.CreatePullRequest,
	listPullRequests *usecase.ListPullRequests,
	listWorkItems *usecase.ListWorkItems,
	getRateLimitStatus *usecase.GetRateLimitStatus,
	getAuthStatus *usecase.GetAuthStatus,
	startOAuthFlow *usecase.StartOAuthFlow,
	completeOAuthFlow *usecase.CompleteOAuthFlow,
	revokeAuth *usecase.RevokeAuth,
	mergePullRequest *usecase.MergePullRequest,
	requestPullRequestReviewers *usecase.RequestPullRequestReviewers,
	removePullRequestReviewers *usecase.RemovePullRequestReviewers,
	setPullRequestAutoMerge *usecase.SetPullRequestAutoMerge,
	updateIssue *usecase.UpdateIssue,
	updatePullRequest *usecase.UpdatePullRequest,
	starRepository *usecase.StarRepository,
	getPullRequestForBranch *usecase.GetPullRequestForBranch,
	resolveRepoSlug *usecase.ResolveRepoSlug,
	listAccessibleProjects *usecase.ListAccessibleProjects,
	resolveProjectRef *usecase.ResolveProjectRef,
	listProjectViews *usecase.ListProjectViews,
	viewProjectTable *usecase.ViewProjectTable,
	updateProjectItemField *usecase.UpdateProjectItemField,
	clearProjectItemField *usecase.ClearProjectItemField,
	getWorkItemDetailsBySlug *usecase.GetWorkItemDetailsBySlug,
	updateIssueBySlug *usecase.UpdateIssueBySlug,
	updatePullRequestBySlug *usecase.UpdatePullRequestBySlug,
	updateIssueTypeBySlug *usecase.UpdateIssueTypeBySlug,
	listIssueTypesBySlug *usecase.ListIssueTypesBySlug,
	listAssignableUsersBySlug *usecase.ListAssignableUsersBySlug,
	listLabelsBySlug *usecase.ListLabelsBySlug,
	addIssueCommentBySlug *usecase.AddIssueCommentBySlug,
	updateIssueCommentBySlug *usecase.UpdateIssueCommentBySlug,
	deleteIssueCommentBySlug *usecase.DeleteIssueCommentBySlug,
	listMergeRequests *usecase.ListMergeRequests,
	resolveMergeRequestDiscussion *usecase.ResolveMergeRequestDiscussion,
	getWorkItemDetails *usecase.GetWorkItemDetails,
	checkHostedReviewEligibility *usecase.CheckHostedReviewEligibility,
	setIntegrationCredential *usecase.SetIntegrationCredential,
	getIntegrationCredentialStatus *usecase.GetIntegrationCredentialStatus,
	listIntegrationCredentials *usecase.ListIntegrationCredentials,
) *Server {
	return &Server{
		listIssues:         listIssues,
		createPullRequest:  createPullRequest,
		listPullRequests:   listPullRequests,
		listWorkItems:      listWorkItems,
		getRateLimitStatus: getRateLimitStatus,
		getAuthStatus:      getAuthStatus,
		startOAuthFlow:     startOAuthFlow,
		completeOAuthFlow:  completeOAuthFlow,
		revokeAuth:         revokeAuth,

		mergePullRequest:            mergePullRequest,
		requestPullRequestReviewers: requestPullRequestReviewers,
		removePullRequestReviewers:  removePullRequestReviewers,
		setPullRequestAutoMerge:     setPullRequestAutoMerge,
		updateIssue:                 updateIssue,
		updatePullRequest:           updatePullRequest,
		starRepository:              starRepository,
		getPullRequestForBranch:     getPullRequestForBranch,
		resolveRepoSlug:             resolveRepoSlug,

		listAccessibleProjects:    listAccessibleProjects,
		resolveProjectRef:         resolveProjectRef,
		listProjectViews:          listProjectViews,
		viewProjectTable:          viewProjectTable,
		updateProjectItemField:    updateProjectItemField,
		clearProjectItemField:     clearProjectItemField,
		getWorkItemDetailsBySlug:  getWorkItemDetailsBySlug,
		updateIssueBySlug:         updateIssueBySlug,
		updatePullRequestBySlug:   updatePullRequestBySlug,
		updateIssueTypeBySlug:     updateIssueTypeBySlug,
		listIssueTypesBySlug:      listIssueTypesBySlug,
		listAssignableUsersBySlug: listAssignableUsersBySlug,
		listLabelsBySlug:          listLabelsBySlug,
		addIssueCommentBySlug:     addIssueCommentBySlug,
		updateIssueCommentBySlug:  updateIssueCommentBySlug,
		deleteIssueCommentBySlug:  deleteIssueCommentBySlug,

		listMergeRequests:             listMergeRequests,
		resolveMergeRequestDiscussion: resolveMergeRequestDiscussion,
		getWorkItemDetails:            getWorkItemDetails,

		checkHostedReviewEligibility:   checkHostedReviewEligibility,
		setIntegrationCredential:       setIntegrationCredential,
		getIntegrationCredentialStatus: getIntegrationCredentialStatus,
		listIntegrationCredentials:     listIntegrationCredentials,
	}
}

func (s *Server) ListIssues(ctx context.Context, req *scmintegrationv1.ListIssuesRequest) (*scmintegrationv1.ListIssuesResponse, error) {
	issues, err := s.listIssues.Execute(ctx, usecase.ListIssuesInput{
		TenantID: req.GetTenantId(),
		Provider: toDomainProvider(req.GetProvider()),
		Repo:     req.GetRepo(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	out := make([]*scmintegrationv1.Issue, 0, len(issues))
	for _, i := range issues {
		out = append(out, toProtoIssue(i))
	}
	return &scmintegrationv1.ListIssuesResponse{Issues: out}, nil
}

func (s *Server) CreatePullRequest(ctx context.Context, req *scmintegrationv1.CreatePullRequestRequest) (*scmintegrationv1.CreatePullRequestResponse, error) {
	pr, err := s.createPullRequest.Execute(ctx, usecase.CreatePullRequestParams{
		TenantID:   req.GetTenantId(),
		Provider:   toDomainProvider(req.GetProvider()),
		Repo:       req.GetRepo(),
		Title:      req.GetTitle(),
		Body:       req.GetBody(),
		HeadBranch: req.GetHeadBranch(),
		BaseBranch: req.GetBaseBranch(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &scmintegrationv1.CreatePullRequestResponse{PullRequest: toProtoPullRequest(pr)}, nil
}

func (s *Server) ListPullRequests(ctx context.Context, req *scmintegrationv1.ListPullRequestsRequest) (*scmintegrationv1.ListPullRequestsResponse, error) {
	prs, err := s.listPullRequests.Execute(ctx, usecase.ListPullRequestsInput{
		TenantID: req.GetTenantId(),
		Provider: toDomainProvider(req.GetProvider()),
		Repo:     req.GetRepo(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	out := make([]*scmintegrationv1.PullRequest, 0, len(prs))
	for _, pr := range prs {
		out = append(out, toProtoPullRequest(pr))
	}
	return &scmintegrationv1.ListPullRequestsResponse{PullRequests: out}, nil
}

func (s *Server) ListWorkItems(ctx context.Context, req *scmintegrationv1.ListWorkItemsRequest) (*scmintegrationv1.ListWorkItemsResponse, error) {
	items, err := s.listWorkItems.Execute(ctx, usecase.ListWorkItemsInput{
		TenantID: req.GetTenantId(),
		Provider: toDomainProvider(req.GetProvider()),
		Repo:     req.GetRepo(),
		Query:    req.GetQuery(),
		Limit:    req.GetLimit(),
		Before:   req.GetBefore(),
		NoCache:  req.GetNoCache(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	out := make([]*scmintegrationv1.WorkItem, 0, len(items))
	for _, item := range items {
		out = append(out, toProtoWorkItem(item))
	}
	return &scmintegrationv1.ListWorkItemsResponse{WorkItems: out}, nil
}

func (s *Server) GetRateLimitStatus(ctx context.Context, req *scmintegrationv1.GetRateLimitStatusRequest) (*scmintegrationv1.GetRateLimitStatusResponse, error) {
	status, err := s.getRateLimitStatus.Execute(ctx, usecase.GetRateLimitStatusInput{
		TenantID: req.GetTenantId(),
		Provider: toDomainProvider(req.GetProvider()),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &scmintegrationv1.GetRateLimitStatusResponse{
		Remaining: int32(status.Remaining),
		Limit:     int32(status.Limit),
		ResetUnix: status.ResetAt.Unix(),
	}, nil
}

func (s *Server) GetAuthStatus(ctx context.Context, req *scmintegrationv1.GetAuthStatusRequest) (*scmintegrationv1.GetAuthStatusResponse, error) {
	connected, err := s.getAuthStatus.Execute(ctx, usecase.GetAuthStatusInput{
		TenantID: req.GetTenantId(),
		Provider: toDomainProvider(req.GetProvider()),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &scmintegrationv1.GetAuthStatusResponse{Connected: connected}, nil
}

func (s *Server) StartOAuthFlow(ctx context.Context, req *scmintegrationv1.StartOAuthFlowRequest) (*scmintegrationv1.StartOAuthFlowResponse, error) {
	result, err := s.startOAuthFlow.Execute(ctx, usecase.StartOAuthFlowInput{
		TenantID:    req.GetTenantId(),
		UserID:      req.GetUserId(),
		Provider:    toDomainProvider(req.GetProvider()),
		RedirectURI: req.GetRedirectUri(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &scmintegrationv1.StartOAuthFlowResponse{AuthorizationUrl: result.AuthorizationURL, State: result.State}, nil
}

func (s *Server) CompleteOAuthFlow(ctx context.Context, req *scmintegrationv1.CompleteOAuthFlowRequest) (*scmintegrationv1.CompleteOAuthFlowResponse, error) {
	connected, err := s.completeOAuthFlow.Execute(ctx, usecase.CompleteOAuthFlowInput{
		TenantID:    req.GetTenantId(),
		UserID:      req.GetUserId(),
		Provider:    toDomainProvider(req.GetProvider()),
		Code:        req.GetCode(),
		State:       req.GetState(),
		RedirectURI: req.GetRedirectUri(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &scmintegrationv1.CompleteOAuthFlowResponse{Connected: connected}, nil
}

func (s *Server) RevokeAuth(ctx context.Context, req *scmintegrationv1.RevokeAuthRequest) (*scmintegrationv1.RevokeAuthResponse, error) {
	if err := s.revokeAuth.Execute(ctx, usecase.RevokeAuthInput{
		TenantID: req.GetTenantId(),
		Provider: toDomainProvider(req.GetProvider()),
	}); err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &scmintegrationv1.RevokeAuthResponse{}, nil
}

// ── SOL-012 shape 1/2 — GitHub PR/issue mutations + repo/branch resolution ──

func (s *Server) MergePullRequest(ctx context.Context, req *scmintegrationv1.MergePullRequestRequest) (*scmintegrationv1.MergePullRequestResponse, error) {
	result, err := s.mergePullRequest.Execute(ctx, usecase.MergePullRequestParams{
		TenantID: req.GetTenantId(), Provider: toDomainProvider(req.GetProvider()), Repo: req.GetRepo(),
		Number: req.GetNumber(), MergeMethod: req.GetMergeMethod(), CommitTitle: req.GetCommitTitle(), CommitMessage: req.GetCommitMessage(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &scmintegrationv1.MergePullRequestResponse{
		PullRequest: toProtoPullRequest(result.PullRequest), Merged: result.Merged, Sha: result.SHA,
	}, nil
}

func (s *Server) RequestPullRequestReviewers(ctx context.Context, req *scmintegrationv1.RequestPullRequestReviewersRequest) (*scmintegrationv1.PullRequest, error) {
	pr, err := s.requestPullRequestReviewers.Execute(ctx, usecase.RequestPullRequestReviewersParams{
		TenantID: req.GetTenantId(), Provider: toDomainProvider(req.GetProvider()), Repo: req.GetRepo(),
		Number: req.GetNumber(), ReviewerLogins: req.GetReviewerLogins(), TeamSlugs: req.GetTeamSlugs(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return toProtoPullRequest(pr), nil
}

func (s *Server) RemovePullRequestReviewers(ctx context.Context, req *scmintegrationv1.RemovePullRequestReviewersRequest) (*scmintegrationv1.PullRequest, error) {
	pr, err := s.removePullRequestReviewers.Execute(ctx, usecase.RemovePullRequestReviewersParams{
		TenantID: req.GetTenantId(), Provider: toDomainProvider(req.GetProvider()), Repo: req.GetRepo(),
		Number: req.GetNumber(), ReviewerLogins: req.GetReviewerLogins(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return toProtoPullRequest(pr), nil
}

func (s *Server) SetPullRequestAutoMerge(ctx context.Context, req *scmintegrationv1.SetPullRequestAutoMergeRequest) (*scmintegrationv1.PullRequest, error) {
	pr, err := s.setPullRequestAutoMerge.Execute(ctx, usecase.SetPullRequestAutoMergeParams{
		TenantID: req.GetTenantId(), Provider: toDomainProvider(req.GetProvider()), Repo: req.GetRepo(),
		Number: req.GetNumber(), Enabled: req.GetEnabled(), MergeMethod: req.GetMergeMethod(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return toProtoPullRequest(pr), nil
}

func (s *Server) UpdateIssue(ctx context.Context, req *scmintegrationv1.UpdateIssueRequest) (*scmintegrationv1.Issue, error) {
	patch := usecase.IssuePatch{AddLabels: req.GetAddLabels(), RemoveLabels: req.GetRemoveLabels(), Assignees: req.GetAssignees()}
	if req.Title != nil {
		v := req.GetTitle()
		patch.Title = &v
	}
	if req.Body != nil {
		v := req.GetBody()
		patch.Body = &v
	}
	if req.State != nil {
		v := req.GetState()
		patch.State = &v
	}
	issue, err := s.updateIssue.Execute(ctx, usecase.UpdateIssueParams{
		TenantID: req.GetTenantId(), Provider: toDomainProvider(req.GetProvider()), Repo: req.GetRepo(),
		Number: req.GetNumber(), Patch: patch,
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return toProtoIssue(issue), nil
}

func (s *Server) UpdatePullRequest(ctx context.Context, req *scmintegrationv1.UpdatePullRequestRequest) (*scmintegrationv1.PullRequest, error) {
	patch := usecase.PullRequestPatch{}
	if req.Title != nil {
		v := req.GetTitle()
		patch.Title = &v
	}
	pr, err := s.updatePullRequest.Execute(ctx, usecase.UpdatePullRequestParams{
		TenantID: req.GetTenantId(), Provider: toDomainProvider(req.GetProvider()), Repo: req.GetRepo(),
		Number: req.GetNumber(), Patch: patch,
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return toProtoPullRequest(pr), nil
}

func (s *Server) StarRepository(ctx context.Context, req *scmintegrationv1.StarRepositoryRequest) (*scmintegrationv1.StarRepositoryResponse, error) {
	starred, err := s.starRepository.Execute(ctx, usecase.StarRepositoryParams{
		TenantID: req.GetTenantId(), Provider: toDomainProvider(req.GetProvider()), Repo: req.GetRepo(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &scmintegrationv1.StarRepositoryResponse{Starred: starred}, nil
}

func (s *Server) GetPullRequestForBranch(ctx context.Context, req *scmintegrationv1.GetPullRequestForBranchRequest) (*scmintegrationv1.GetPullRequestForBranchResponse, error) {
	result, err := s.getPullRequestForBranch.Execute(ctx, usecase.GetPullRequestForBranchParams{
		TenantID: req.GetTenantId(), Provider: toDomainProvider(req.GetProvider()), Repo: req.GetRepo(), HeadBranch: req.GetHeadBranch(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	resp := &scmintegrationv1.GetPullRequestForBranchResponse{Found: result.Found}
	if result.Found {
		resp.PullRequest = toProtoPullRequest(result.PullRequest)
	}
	return resp, nil
}

func (s *Server) ResolveRepoSlug(ctx context.Context, req *scmintegrationv1.ResolveRepoSlugRequest) (*scmintegrationv1.ResolveRepoSlugResponse, error) {
	result, err := s.resolveRepoSlug.Execute(ctx, usecase.ResolveRepoSlugParams{
		TenantID: req.GetTenantId(), Provider: toDomainProvider(req.GetProvider()), Candidate: req.GetCandidate(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &scmintegrationv1.ResolveRepoSlugResponse{Owner: result.Owner, Name: result.Name, Slug: result.Slug}, nil
}

// ── SOL-012 shape 3 — GitHub Projects v2 ────────────────────────────────
//
// Provider: domain.ScmProviderGitHub is hardcoded per RPC (not read from
// req.GetProvider()) for every RPC in this section — TASK-077's proto
// messages for this sub-surface deliberately have no `provider` field
// (GitHub-only by construction, per SOL-012's framing).

func (s *Server) ListAccessibleProjects(ctx context.Context, req *scmintegrationv1.ListAccessibleProjectsRequest) (*scmintegrationv1.ListAccessibleProjectsResponse, error) {
	projects, err := s.listAccessibleProjects.Execute(ctx, usecase.ListAccessibleProjectsParams{
		TenantID: req.GetTenantId(), Provider: domain.ScmProviderGitHub,
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	out := make([]*scmintegrationv1.Project, 0, len(projects))
	for _, p := range projects {
		out = append(out, toProtoProject(p))
	}
	return &scmintegrationv1.ListAccessibleProjectsResponse{Projects: out}, nil
}

func (s *Server) ResolveProjectRef(ctx context.Context, req *scmintegrationv1.ResolveProjectRefRequest) (*scmintegrationv1.ResolveProjectRefResponse, error) {
	project, err := s.resolveProjectRef.Execute(ctx, usecase.ResolveProjectRefParams{
		TenantID: req.GetTenantId(), Provider: domain.ScmProviderGitHub, Owner: req.GetOwner(), Number: req.GetNumber(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &scmintegrationv1.ResolveProjectRefResponse{Slug: project.Slug, Project: toProtoProject(project)}, nil
}

func (s *Server) ListProjectViews(ctx context.Context, req *scmintegrationv1.ListProjectViewsRequest) (*scmintegrationv1.ListProjectViewsResponse, error) {
	views, err := s.listProjectViews.Execute(ctx, usecase.ListProjectViewsParams{
		TenantID: req.GetTenantId(), Provider: domain.ScmProviderGitHub, ProjectSlug: req.GetProjectSlug(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	out := make([]*scmintegrationv1.ProjectView, 0, len(views))
	for _, v := range views {
		out = append(out, toProtoProjectView(v))
	}
	return &scmintegrationv1.ListProjectViewsResponse{Views: out}, nil
}

func (s *Server) ViewProjectTable(ctx context.Context, req *scmintegrationv1.ViewProjectTableRequest) (*scmintegrationv1.ViewProjectTableResponse, error) {
	result, err := s.viewProjectTable.Execute(ctx, usecase.ViewProjectTableParams{
		TenantID: req.GetTenantId(), Provider: domain.ScmProviderGitHub, ProjectSlug: req.GetProjectSlug(),
		ViewID: req.GetViewId(), PageToken: req.GetPageToken(), PageSize: req.GetPageSize(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	out := make([]*scmintegrationv1.ProjectItem, 0, len(result.Items))
	for _, item := range result.Items {
		out = append(out, toProtoProjectItem(item))
	}
	return &scmintegrationv1.ViewProjectTableResponse{Items: out, NextPageToken: result.NextPageToken}, nil
}

func (s *Server) UpdateProjectItemField(ctx context.Context, req *scmintegrationv1.UpdateProjectItemFieldRequest) (*scmintegrationv1.ProjectItem, error) {
	item, err := s.updateProjectItemField.Execute(ctx, usecase.UpdateProjectItemFieldParams{
		TenantID: req.GetTenantId(), Provider: domain.ScmProviderGitHub,
		ProjectSlug: req.GetProjectSlug(), ItemID: req.GetItemId(),
		Field: usecase.ProjectFieldValue{FieldID: req.GetField().GetFieldId(), Kind: req.GetField().GetKind(), Value: req.GetField().GetValue()},
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return toProtoProjectItem(item), nil
}

func (s *Server) ClearProjectItemField(ctx context.Context, req *scmintegrationv1.ClearProjectItemFieldRequest) (*scmintegrationv1.ProjectItem, error) {
	item, err := s.clearProjectItemField.Execute(ctx, usecase.ClearProjectItemFieldParams{
		TenantID: req.GetTenantId(), Provider: domain.ScmProviderGitHub,
		ProjectSlug: req.GetProjectSlug(), ItemID: req.GetItemId(), FieldID: req.GetFieldId(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return toProtoProjectItem(item), nil
}

func (s *Server) GetWorkItemDetailsBySlug(ctx context.Context, req *scmintegrationv1.GetWorkItemDetailsBySlugRequest) (*scmintegrationv1.WorkItemDetails, error) {
	details, err := s.getWorkItemDetailsBySlug.Execute(ctx, usecase.GetWorkItemDetailsBySlugParams{
		TenantID: req.GetTenantId(), Provider: domain.ScmProviderGitHub, ItemSlug: req.GetItemSlug(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return toProtoWorkItemDetails(details), nil
}

func (s *Server) UpdateIssueBySlug(ctx context.Context, req *scmintegrationv1.UpdateIssueBySlugRequest) (*scmintegrationv1.WorkItemDetails, error) {
	patch := usecase.WorkItemPatch{AddLabels: req.GetAddLabels(), RemoveLabels: req.GetRemoveLabels()}
	if req.Title != nil {
		v := req.GetTitle()
		patch.Title = &v
	}
	if req.Body != nil {
		v := req.GetBody()
		patch.Body = &v
	}
	if req.State != nil {
		v := req.GetState()
		patch.State = &v
	}
	details, err := s.updateIssueBySlug.Execute(ctx, usecase.UpdateIssueBySlugParams{
		TenantID: req.GetTenantId(), Provider: domain.ScmProviderGitHub, ItemSlug: req.GetItemSlug(), Patch: patch,
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return toProtoWorkItemDetails(details), nil
}

func (s *Server) UpdatePullRequestBySlug(ctx context.Context, req *scmintegrationv1.UpdatePullRequestBySlugRequest) (*scmintegrationv1.WorkItemDetails, error) {
	patch := usecase.WorkItemPatch{}
	if req.Title != nil {
		v := req.GetTitle()
		patch.Title = &v
	}
	if req.Body != nil {
		v := req.GetBody()
		patch.Body = &v
	}
	if req.State != nil {
		v := req.GetState()
		patch.State = &v
	}
	details, err := s.updatePullRequestBySlug.Execute(ctx, usecase.UpdatePullRequestBySlugParams{
		TenantID: req.GetTenantId(), Provider: domain.ScmProviderGitHub, ItemSlug: req.GetItemSlug(), Patch: patch,
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return toProtoWorkItemDetails(details), nil
}

func (s *Server) UpdateIssueTypeBySlug(ctx context.Context, req *scmintegrationv1.UpdateIssueTypeBySlugRequest) (*scmintegrationv1.WorkItemDetails, error) {
	details, err := s.updateIssueTypeBySlug.Execute(ctx, usecase.UpdateIssueTypeBySlugParams{
		TenantID: req.GetTenantId(), Provider: domain.ScmProviderGitHub, ItemSlug: req.GetItemSlug(), IssueType: req.GetIssueType(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return toProtoWorkItemDetails(details), nil
}

func (s *Server) ListIssueTypesBySlug(ctx context.Context, req *scmintegrationv1.ListIssueTypesBySlugRequest) (*scmintegrationv1.ListIssueTypesBySlugResponse, error) {
	types, err := s.listIssueTypesBySlug.Execute(ctx, usecase.ListIssueTypesBySlugParams{
		TenantID: req.GetTenantId(), Provider: domain.ScmProviderGitHub, ItemSlug: req.GetItemSlug(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	out := make([]*scmintegrationv1.IssueType, 0, len(types))
	for _, t := range types {
		out = append(out, toProtoIssueType(t))
	}
	return &scmintegrationv1.ListIssueTypesBySlugResponse{IssueTypes: out}, nil
}

func (s *Server) ListAssignableUsersBySlug(ctx context.Context, req *scmintegrationv1.ListAssignableUsersBySlugRequest) (*scmintegrationv1.ListAssignableUsersBySlugResponse, error) {
	users, err := s.listAssignableUsersBySlug.Execute(ctx, usecase.ListAssignableUsersBySlugParams{
		TenantID: req.GetTenantId(), Provider: domain.ScmProviderGitHub, ItemSlug: req.GetItemSlug(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	out := make([]*scmintegrationv1.AssignableUser, 0, len(users))
	for _, u := range users {
		out = append(out, toProtoAssignableUser(u))
	}
	return &scmintegrationv1.ListAssignableUsersBySlugResponse{Users: out}, nil
}

func (s *Server) ListLabelsBySlug(ctx context.Context, req *scmintegrationv1.ListLabelsBySlugRequest) (*scmintegrationv1.ListLabelsBySlugResponse, error) {
	labels, err := s.listLabelsBySlug.Execute(ctx, usecase.ListLabelsBySlugParams{
		TenantID: req.GetTenantId(), Provider: domain.ScmProviderGitHub, ItemSlug: req.GetItemSlug(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	out := make([]*scmintegrationv1.Label, 0, len(labels))
	for _, l := range labels {
		out = append(out, toProtoLabel(l))
	}
	return &scmintegrationv1.ListLabelsBySlugResponse{Labels: out}, nil
}

func (s *Server) AddIssueCommentBySlug(ctx context.Context, req *scmintegrationv1.AddIssueCommentBySlugRequest) (*scmintegrationv1.ProjectComment, error) {
	comment, err := s.addIssueCommentBySlug.Execute(ctx, usecase.AddIssueCommentBySlugParams{
		TenantID: req.GetTenantId(), Provider: domain.ScmProviderGitHub, ItemSlug: req.GetItemSlug(), Body: req.GetBody(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return toProtoProjectComment(comment), nil
}

func (s *Server) UpdateIssueCommentBySlug(ctx context.Context, req *scmintegrationv1.UpdateIssueCommentBySlugRequest) (*scmintegrationv1.ProjectComment, error) {
	comment, err := s.updateIssueCommentBySlug.Execute(ctx, usecase.UpdateIssueCommentBySlugParams{
		TenantID: req.GetTenantId(), Provider: domain.ScmProviderGitHub, ItemSlug: req.GetItemSlug(),
		CommentID: req.GetCommentId(), Body: req.GetBody(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return toProtoProjectComment(comment), nil
}

func (s *Server) DeleteIssueCommentBySlug(ctx context.Context, req *scmintegrationv1.DeleteIssueCommentBySlugRequest) (*emptypb.Empty, error) {
	if err := s.deleteIssueCommentBySlug.Execute(ctx, usecase.DeleteIssueCommentBySlugParams{
		TenantID: req.GetTenantId(), Provider: domain.ScmProviderGitHub, ItemSlug: req.GetItemSlug(), CommentID: req.GetCommentId(),
	}); err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &emptypb.Empty{}, nil
}

// ── SOL-013 — GitLab-specific ────────────────────────────────────────────

func (s *Server) ListMergeRequests(ctx context.Context, req *scmintegrationv1.ListMergeRequestsRequest) (*scmintegrationv1.ListMergeRequestsResponse, error) {
	mrs, err := s.listMergeRequests.Execute(ctx, usecase.ListMergeRequestsParams{
		TenantID: req.GetTenantId(), Repo: req.GetRepo(), State: req.GetState(), SourceBranch: req.GetSourceBranch(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	out := make([]*scmintegrationv1.MergeRequest, 0, len(mrs))
	for _, mr := range mrs {
		out = append(out, toProtoMergeRequest(mr))
	}
	return &scmintegrationv1.ListMergeRequestsResponse{MergeRequests: out}, nil
}

func (s *Server) ResolveMergeRequestDiscussion(ctx context.Context, req *scmintegrationv1.ResolveMergeRequestDiscussionRequest) (*scmintegrationv1.MergeRequestDiscussion, error) {
	disc, err := s.resolveMergeRequestDiscussion.Execute(ctx, usecase.ResolveMergeRequestDiscussionParams{
		TenantID: req.GetTenantId(), Repo: req.GetRepo(), MergeRequestIID: req.GetMergeRequestIid(),
		DiscussionID: req.GetDiscussionId(), Resolved: req.GetResolved(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return toProtoMergeRequestDiscussion(disc), nil
}

func (s *Server) GetWorkItemDetails(ctx context.Context, req *scmintegrationv1.GetWorkItemDetailsRequest) (*scmintegrationv1.WorkItemDetailsGitLab, error) {
	details, err := s.getWorkItemDetails.Execute(ctx, usecase.GetWorkItemDetailsParams{
		TenantID: req.GetTenantId(), Repo: req.GetRepo(), IID: req.GetIid(), ItemType: req.GetItemType(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return toProtoWorkItemDetailsGitLab(details), nil
}

// ── SOL-014 — hostedReview.getCreationEligibility ───────────────────────

func (s *Server) CheckHostedReviewEligibility(ctx context.Context, req *scmintegrationv1.CheckHostedReviewEligibilityRequest) (*scmintegrationv1.HostedReviewEligibility, error) {
	result, err := s.checkHostedReviewEligibility.Execute(ctx, usecase.CheckHostedReviewEligibilityParams{
		TenantID: req.GetTenantId(), Provider: toDomainProvider(req.GetProvider()), Repo: req.GetRepo(),
		HeadBranch: req.GetHeadBranch(), BaseBranch: req.GetBaseBranch(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	resp := &scmintegrationv1.HostedReviewEligibility{Eligible: result.Eligible, IneligibleReason: result.IneligibleReason}
	if result.IneligibleReason == "REVIEW_ALREADY_EXISTS" {
		resp.ExistingPullRequest = toProtoPullRequest(result.ExistingPullRequest)
	}
	return resp, nil
}

func (s *Server) SetIntegrationCredential(ctx context.Context, req *scmintegrationv1.SetIntegrationCredentialRequest) (*scmintegrationv1.SetIntegrationCredentialResponse, error) {
	if err := s.setIntegrationCredential.Execute(ctx, usecase.SetIntegrationCredentialInput{
		TenantID:   req.GetTenantId(),
		Provider:   toDomainProvider(req.GetProvider()),
		Token:      req.GetToken(),
		ConfigJSON: req.GetConfigJson(),
	}); err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &scmintegrationv1.SetIntegrationCredentialResponse{}, nil
}

func (s *Server) GetIntegrationCredentialStatus(ctx context.Context, req *scmintegrationv1.GetIntegrationCredentialStatusRequest) (*scmintegrationv1.GetIntegrationCredentialStatusResponse, error) {
	result, err := s.getIntegrationCredentialStatus.Execute(ctx, usecase.GetIntegrationCredentialStatusInput{
		TenantID: req.GetTenantId(),
		Provider: toDomainProvider(req.GetProvider()),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &scmintegrationv1.GetIntegrationCredentialStatusResponse{
		Configured: result.Configured,
		ConfigJson: result.ConfigJSON,
	}, nil
}

func (s *Server) ListIntegrationCredentials(ctx context.Context, req *scmintegrationv1.ListIntegrationCredentialsRequest) (*scmintegrationv1.ListIntegrationCredentialsResponse, error) {
	providers, err := s.listIntegrationCredentials.Execute(ctx, req.GetTenantId())
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	out := make([]scmintegrationv1.ScmProvider, 0, len(providers))
	for _, p := range providers {
		out = append(out, toProtoProvider(p))
	}
	return &scmintegrationv1.ListIntegrationCredentialsResponse{ConfiguredProviders: out}, nil
}

func toDomainProvider(p scmintegrationv1.ScmProvider) domain.ScmProvider {
	switch p {
	case scmintegrationv1.ScmProvider_SCM_PROVIDER_GITHUB:
		return domain.ScmProviderGitHub
	case scmintegrationv1.ScmProvider_SCM_PROVIDER_GITLAB:
		return domain.ScmProviderGitLab
	case scmintegrationv1.ScmProvider_SCM_PROVIDER_BITBUCKET:
		return domain.ScmProviderBitbucket
	case scmintegrationv1.ScmProvider_SCM_PROVIDER_AZURE_DEVOPS:
		return domain.ScmProviderAzureDevOps
	case scmintegrationv1.ScmProvider_SCM_PROVIDER_GITEA:
		return domain.ScmProviderGitea
	default:
		return ""
	}
}

func toProtoProvider(p domain.ScmProvider) scmintegrationv1.ScmProvider {
	switch p {
	case domain.ScmProviderGitHub:
		return scmintegrationv1.ScmProvider_SCM_PROVIDER_GITHUB
	case domain.ScmProviderGitLab:
		return scmintegrationv1.ScmProvider_SCM_PROVIDER_GITLAB
	case domain.ScmProviderBitbucket:
		return scmintegrationv1.ScmProvider_SCM_PROVIDER_BITBUCKET
	case domain.ScmProviderAzureDevOps:
		return scmintegrationv1.ScmProvider_SCM_PROVIDER_AZURE_DEVOPS
	case domain.ScmProviderGitea:
		return scmintegrationv1.ScmProvider_SCM_PROVIDER_GITEA
	default:
		return scmintegrationv1.ScmProvider_SCM_PROVIDER_UNSPECIFIED
	}
}

func toProtoIssue(i domain.Issue) *scmintegrationv1.Issue {
	return &scmintegrationv1.Issue{
		Id:     i.ID,
		Title:  i.Title,
		State:  i.State,
		Url:    i.URL,
		Number: i.Number,
	}
}

func toProtoPullRequest(pr domain.PullRequest) *scmintegrationv1.PullRequest {
	return &scmintegrationv1.PullRequest{
		Id:     pr.ID,
		Url:    pr.URL,
		State:  pr.State,
		Number: pr.Number,
	}
}

func toProtoWorkItem(w domain.WorkItem) *scmintegrationv1.WorkItem {
	return &scmintegrationv1.WorkItem{
		Id:        w.ID,
		Type:      w.Type,
		Number:    w.Number,
		Title:     w.Title,
		State:     w.State,
		Url:       w.URL,
		Labels:    w.Labels,
		UpdatedAt: w.UpdatedAt.Format(time.RFC3339),
		Author:    w.Author,
	}
}

func toProtoProject(p usecase.Project) *scmintegrationv1.Project {
	return &scmintegrationv1.Project{
		Id: p.ID, Slug: p.Slug, Title: p.Title, Number: p.Number, Owner: p.Owner, Url: p.URL,
	}
}

func toProtoProjectView(v usecase.ProjectView) *scmintegrationv1.ProjectView {
	return &scmintegrationv1.ProjectView{Id: v.ID, Name: v.Name, Layout: v.Layout}
}

func toProtoProjectItem(item usecase.ProjectItem) *scmintegrationv1.ProjectItem {
	fields := make([]*scmintegrationv1.ProjectFieldValue, 0, len(item.Fields))
	for _, f := range item.Fields {
		fields = append(fields, &scmintegrationv1.ProjectFieldValue{FieldId: f.FieldID, Kind: f.Kind, Value: f.Value})
	}
	return &scmintegrationv1.ProjectItem{Id: item.ID, Title: item.Title, ContentType: item.ContentType, ContentUrl: item.ContentURL, Fields: fields}
}

func toProtoWorkItemDetails(d usecase.WorkItemDetails) *scmintegrationv1.WorkItemDetails {
	fields := make([]*scmintegrationv1.ProjectFieldValue, 0, len(d.Fields))
	for _, f := range d.Fields {
		fields = append(fields, &scmintegrationv1.ProjectFieldValue{FieldId: f.FieldID, Kind: f.Kind, Value: f.Value})
	}
	return &scmintegrationv1.WorkItemDetails{Slug: d.Slug, Title: d.Title, Body: d.Body, State: d.State, Url: d.URL, Fields: fields}
}

func toProtoIssueType(t usecase.IssueType) *scmintegrationv1.IssueType {
	return &scmintegrationv1.IssueType{Id: t.ID, Name: t.Name, Description: t.Description}
}

func toProtoAssignableUser(u usecase.AssignableUser) *scmintegrationv1.AssignableUser {
	return &scmintegrationv1.AssignableUser{Login: u.Login, Name: u.Name, AvatarUrl: u.AvatarURL}
}

func toProtoLabel(l usecase.Label) *scmintegrationv1.Label {
	return &scmintegrationv1.Label{Name: l.Name, Color: l.Color, Description: l.Description}
}

func toProtoProjectComment(c usecase.ProjectComment) *scmintegrationv1.ProjectComment {
	return &scmintegrationv1.ProjectComment{Id: c.ID, Body: c.Body, Author: c.Author, Url: c.URL}
}

func toProtoMergeRequest(mr domain.MergeRequest) *scmintegrationv1.MergeRequest {
	return &scmintegrationv1.MergeRequest{
		Id: mr.ID, Url: mr.URL, State: mr.State, Iid: mr.IID, Title: mr.Title,
		SourceBranch: mr.SourceBranch, TargetBranch: mr.TargetBranch, Draft: mr.Draft,
		DiscussionCount: mr.DiscussionCount, UnresolvedDiscussionCount: mr.UnresolvedDiscussionCount,
		MergeStatus: mr.MergeStatus,
	}
}

func toProtoMergeRequestDiscussion(d domain.MergeRequestDiscussion) *scmintegrationv1.MergeRequestDiscussion {
	return &scmintegrationv1.MergeRequestDiscussion{Id: d.ID, Resolved: d.Resolved, ResolvedBy: d.ResolvedBy}
}

func toProtoWorkItemDetailsGitLab(d domain.WorkItemDetailsGitLab) *scmintegrationv1.WorkItemDetailsGitLab {
	return &scmintegrationv1.WorkItemDetailsGitLab{
		Id: d.ID, Iid: d.IID, ItemType: d.ItemType, Title: d.Title, Body: d.Body, State: d.State, Url: d.URL, Labels: d.Labels,
	}
}
