// Package gitlab implements usecase.ScmProvider against GitLab's REST API v4
// (https://gitlab.com/api/v4) directly via net/http — no glab CLI, no shared
// keychain, no shell-out, per scm-integration-service.md §10. Every
// ScmProvider method is a real REST call, structurally mirroring
// internal/adapter/github (the reference implementation the other provider
// adapters mirror): the resolved per-tenant token is built directly into the
// auth header immediately before dispatch, never stored on the Client or
// logged.
package gitlab

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/stablyai/orca-go/services/scm-integration-service/internal/domain"
	"github.com/stablyai/orca-go/services/scm-integration-service/internal/usecase"
)

// DefaultBaseURL is GitLab.com's public REST API v4 root.
const DefaultBaseURL = "https://gitlab.com/api/v4"

// ErrNotImplemented is kept as a sentinel for any future method added to
// usecase.ScmProvider before this adapter implements it — every method
// currently in the interface is real.
var ErrNotImplemented = errors.New("gitlab: not implemented")

// ErrCapabilityUnsupported is returned by the SOL-012 GitHub-mutation-shaped
// ScmProvider methods (MergePullRequest/RequestPullRequestReviewers/
// RemovePullRequestReviewers/SetPullRequestAutoMerge/UpdateIssue/
// GetPullRequestForBranch/ResolveRepoSlug) — GitLab's own review-mutation
// surface is covered instead by GitLabMergeRequestProvider (SOL-013,
// ListMergeRequests/ResolveDiscussion/GetWorkItemDetails), a separate port;
// these ScmProvider methods stay unsupported here rather than faking
// support, mirroring the azuredevops/gitea ErrCapabilityUnsupported
// precedent.
var ErrCapabilityUnsupported = errors.New("gitlab: capability not supported")

// Client implements usecase.ScmProvider against GitLab's REST API.
type Client struct {
	httpClient *http.Client
	baseURL    string
}

// New returns a GitLab Client. A nil httpClient defaults to
// http.DefaultClient; an empty baseURL defaults to DefaultBaseURL —
// overridable for tests (httptest.Server) and self-managed GitLab
// deployments.
func New(httpClient *http.Client, baseURL string) *Client {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	return &Client{httpClient: httpClient, baseURL: baseURL}
}

var _ usecase.ScmProvider = (*Client)(nil)

// projectPath builds the {id} path segment GitLab's v4 API expects — a
// numeric project id or a URL-encoded "namespace/project" path. repo is not
// assumed to be pre-escaped, so it's escaped here.
func projectPath(repo string) string {
	return url.PathEscape(repo)
}

// gitlabIssue mirrors the fields this adapter needs from GitLab's
// GET /projects/{id}/issues response
// (https://docs.gitlab.com/ee/api/issues.html#list-project-issues). Unlike
// GitHub, GitLab's issues endpoint never returns merge requests, so there is
// no PullRequest-shaped field to filter out here.
type gitlabIssue struct {
	IID   int    `json:"iid"`
	Title string `json:"title"`
	State string `json:"state"`
	URL   string `json:"web_url"`
}

// ListIssues calls GitLab's REST API for real: GET
// /projects/{id}/issues, with the resolved per-tenant token as a Bearer
// credential — per scm-integration-service.md §9, this is the only place
// that token exists, built directly into the auth header immediately before
// dispatch, never stored on the Client or logged.
func (c *Client) ListIssues(ctx context.Context, cred usecase.Credential, repo string, filter usecase.IssueFilter) ([]domain.Issue, error) {
	reqURL := fmt.Sprintf("%s/projects/%s/issues", c.baseURL, projectPath(repo))
	if filter.State != "" {
		reqURL += "?state=" + url.QueryEscape(filter.State)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, fmt.Errorf("gitlab: build list issues request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+cred.Token)
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("gitlab: list issues request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("gitlab: list issues: unexpected status %d", resp.StatusCode)
	}

	var raw []gitlabIssue
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, fmt.Errorf("gitlab: decode list issues response: %w", err)
	}

	issues := make([]domain.Issue, 0, len(raw))
	for _, gi := range raw {
		issue, err := domain.NewIssue(strconv.Itoa(gi.IID), domain.ScmProviderGitLab, repo, gi.Title, gi.State, gi.URL)
		if err != nil {
			return nil, fmt.Errorf("gitlab: invalid issue in response: %w", err)
		}
		issues = append(issues, issue)
	}
	return issues, nil
}

// gitlabMergeRequest mirrors the fields this adapter needs from GitLab's
// POST/GET /projects/{id}/merge_requests response shape
// (https://docs.gitlab.com/ee/api/merge_requests.html) — GitLab's name for
// what GitHub calls a pull request.
type gitlabMergeRequest struct {
	IID          int    `json:"iid"`
	Title        string `json:"title"`
	State        string `json:"state"`
	URL          string `json:"web_url"`
	SourceBranch string `json:"source_branch"`
	TargetBranch string `json:"target_branch"`
}

func toDomainPullRequest(repo string, gm gitlabMergeRequest) (domain.PullRequest, error) {
	return domain.NewPullRequest(
		strconv.Itoa(gm.IID), domain.ScmProviderGitLab, repo, gm.Title, gm.State, gm.URL,
		gm.SourceBranch, gm.TargetBranch,
	)
}

// CreatePullRequest calls GitLab's REST API for real: POST
// /projects/{id}/merge_requests, with the resolved per-tenant token as a
// Bearer credential — see ListIssues' doc comment for the token-handling
// invariant this shares.
func (c *Client) CreatePullRequest(ctx context.Context, cred usecase.Credential, repo string, input usecase.CreatePullRequestInput) (domain.PullRequest, error) {
	body, err := json.Marshal(struct {
		Title        string `json:"title"`
		Description  string `json:"description,omitempty"`
		SourceBranch string `json:"source_branch"`
		TargetBranch string `json:"target_branch"`
	}{Title: input.Title, Description: input.Body, SourceBranch: input.HeadBranch, TargetBranch: input.BaseBranch})
	if err != nil {
		return domain.PullRequest{}, fmt.Errorf("gitlab: encode create pull request body: %w", err)
	}

	reqURL := fmt.Sprintf("%s/projects/%s/merge_requests", c.baseURL, projectPath(repo))
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, reqURL, bytes.NewReader(body))
	if err != nil {
		return domain.PullRequest{}, fmt.Errorf("gitlab: build create pull request request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+cred.Token)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return domain.PullRequest{}, fmt.Errorf("gitlab: create pull request request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusCreated {
		return domain.PullRequest{}, fmt.Errorf("gitlab: create pull request: unexpected status %d", resp.StatusCode)
	}

	var raw gitlabMergeRequest
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return domain.PullRequest{}, fmt.Errorf("gitlab: decode create pull request response: %w", err)
	}
	pr, err := toDomainPullRequest(repo, raw)
	if err != nil {
		return domain.PullRequest{}, fmt.Errorf("gitlab: invalid pull request in response: %w", err)
	}
	return pr, nil
}

// ListPullRequests calls GitLab's REST API for real: GET
// /projects/{id}/merge_requests.
func (c *Client) ListPullRequests(ctx context.Context, cred usecase.Credential, repo string) ([]domain.PullRequest, error) {
	reqURL := fmt.Sprintf("%s/projects/%s/merge_requests", c.baseURL, projectPath(repo))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, fmt.Errorf("gitlab: build list pull requests request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+cred.Token)
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("gitlab: list pull requests request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("gitlab: list pull requests: unexpected status %d", resp.StatusCode)
	}

	var raw []gitlabMergeRequest
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, fmt.Errorf("gitlab: decode list pull requests response: %w", err)
	}
	prs := make([]domain.PullRequest, 0, len(raw))
	for _, gm := range raw {
		pr, err := toDomainPullRequest(repo, gm)
		if err != nil {
			return nil, fmt.Errorf("gitlab: invalid pull request in response: %w", err)
		}
		prs = append(prs, pr)
	}
	return prs, nil
}

// GetRateLimitStatus calls GitLab's REST API for real: GET /user — GitLab
// has no dedicated rate-limit-status endpoint (§8: "one bucket per token");
// it reports remaining quota via RateLimit-* response headers on every API
// call instead, so this uses the cheapest always-available authenticated
// endpoint purely to read those headers.
func (c *Client) GetRateLimitStatus(ctx context.Context, cred usecase.Credential) (domain.RateLimitStatus, error) {
	reqURL := fmt.Sprintf("%s/user", c.baseURL)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return domain.RateLimitStatus{}, fmt.Errorf("gitlab: build rate limit request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+cred.Token)
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return domain.RateLimitStatus{}, fmt.Errorf("gitlab: rate limit request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		return domain.RateLimitStatus{}, fmt.Errorf("gitlab: rate limit: unexpected status %d", resp.StatusCode)
	}

	// A missing header is not a request failure — some GitLab plans/deployments
	// don't send RateLimit-*, so absence just means "no signal", not an error.
	limit, _ := strconv.Atoi(resp.Header.Get("RateLimit-Limit"))
	remaining, _ := strconv.Atoi(resp.Header.Get("RateLimit-Remaining"))
	var resetAt time.Time
	if reset, err := strconv.ParseInt(resp.Header.Get("RateLimit-Reset"), 10, 64); err == nil {
		resetAt = time.Unix(reset, 0)
	}

	return domain.RateLimitStatus{
		Provider:  domain.ScmProviderGitLab,
		Remaining: remaining,
		Limit:     limit,
		ResetAt:   resetAt,
	}, nil
}

// MergePullRequest, RequestPullRequestReviewers, RemovePullRequestReviewers,
// SetPullRequestAutoMerge, UpdateIssue, GetPullRequestForBranch, and
// ResolveRepoSlug are the SOL-012 GitHub-mutation-shaped ScmProvider
// additions — not implemented for GitLab in this pass, see
// ErrCapabilityUnsupported's doc comment. GitLab's own review-mutation
// surface is GitLabMergeRequestProvider below (SOL-013).
func (c *Client) MergePullRequest(_ context.Context, _ usecase.Credential, _ string, _ int32, _ usecase.MergePullRequestInput) (domain.PullRequest, bool, string, error) {
	return domain.PullRequest{}, false, "", ErrCapabilityUnsupported
}

func (c *Client) RequestPullRequestReviewers(_ context.Context, _ usecase.Credential, _ string, _ int32, _, _ []string) (domain.PullRequest, error) {
	return domain.PullRequest{}, ErrCapabilityUnsupported
}

func (c *Client) RemovePullRequestReviewers(_ context.Context, _ usecase.Credential, _ string, _ int32, _ []string) (domain.PullRequest, error) {
	return domain.PullRequest{}, ErrCapabilityUnsupported
}

func (c *Client) SetPullRequestAutoMerge(_ context.Context, _ usecase.Credential, _ string, _ int32, _ bool, _ string) (domain.PullRequest, error) {
	return domain.PullRequest{}, ErrCapabilityUnsupported
}

func (c *Client) UpdateIssue(_ context.Context, _ usecase.Credential, _ string, _ int32, _ usecase.IssuePatch) (domain.Issue, error) {
	return domain.Issue{}, ErrCapabilityUnsupported
}

func (c *Client) UpdatePullRequest(_ context.Context, _ usecase.Credential, _ string, _ int32, _ usecase.PullRequestPatch) (domain.PullRequest, error) {
	return domain.PullRequest{}, ErrCapabilityUnsupported
}

func (c *Client) StarRepository(_ context.Context, _ usecase.Credential, _ string) (bool, error) {
	return false, ErrCapabilityUnsupported
}

func (c *Client) GetPullRequestForBranch(_ context.Context, _ usecase.Credential, _, _ string) (domain.PullRequest, bool, error) {
	return domain.PullRequest{}, false, ErrCapabilityUnsupported
}

func (c *Client) ResolveRepoSlug(_ context.Context, _ usecase.Credential, _ string) (string, string, error) {
	return "", "", ErrCapabilityUnsupported
}

// BranchExists calls GitLab's REST API: GET
// /projects/{id}/repository/branches/{branch} — 200 exists, 404 doesn't.
func (c *Client) BranchExists(ctx context.Context, cred usecase.Credential, repo, branch string) (bool, error) {
	reqURL := fmt.Sprintf("%s/projects/%s/repository/branches/%s", c.baseURL, projectPath(repo), url.PathEscape(branch))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return false, fmt.Errorf("gitlab: build branch exists request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+cred.Token)
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return false, fmt.Errorf("gitlab: branch exists request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	switch resp.StatusCode {
	case http.StatusOK:
		return true, nil
	case http.StatusNotFound:
		return false, nil
	default:
		return false, fmt.Errorf("gitlab: branch exists: unexpected status %d", resp.StatusCode)
	}
}

var _ usecase.GitLabMergeRequestProvider = (*Client)(nil)

// gitlabMergeRequestFull mirrors GitLab's own field naming for
// merge_requests list/get responses when discussion counts are requested.
type gitlabMergeRequestFull struct {
	ID             int    `json:"id"`
	IID            int    `json:"iid"`
	Title          string `json:"title"`
	State          string `json:"state"`
	WebURL         string `json:"web_url"`
	SourceBranch   string `json:"source_branch"`
	TargetBranch   string `json:"target_branch"`
	Draft          bool   `json:"draft"`
	UserNotesCount int    `json:"user_notes_count"`
	MergeStatus    string `json:"detailed_merge_status"`
}

func toDomainMergeRequest(repo string, gm gitlabMergeRequestFull) domain.MergeRequest {
	return domain.MergeRequest{
		ID: strconv.Itoa(gm.ID), Repo: repo, State: gm.State, IID: int32(gm.IID),
		Title: gm.Title, URL: gm.WebURL, SourceBranch: gm.SourceBranch, TargetBranch: gm.TargetBranch,
		Draft: gm.Draft, DiscussionCount: int32(gm.UserNotesCount), MergeStatus: gm.MergeStatus,
	}
}

// ListMergeRequests calls GitLab's REST API: GET
// /projects/{id}/merge_requests, filtered by state/source_branch.
func (c *Client) ListMergeRequests(ctx context.Context, cred usecase.Credential, repo string, filter usecase.MRFilter) ([]domain.MergeRequest, error) {
	reqURL := fmt.Sprintf("%s/projects/%s/merge_requests", c.baseURL, projectPath(repo))
	q := url.Values{}
	if filter.State != "" {
		q.Set("state", filter.State)
	}
	if filter.SourceBranch != "" {
		q.Set("source_branch", filter.SourceBranch)
	}
	if enc := q.Encode(); enc != "" {
		reqURL += "?" + enc
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, fmt.Errorf("gitlab: build list merge requests request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+cred.Token)
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("gitlab: list merge requests request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("gitlab: list merge requests: unexpected status %d", resp.StatusCode)
	}
	var raw []gitlabMergeRequestFull
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, fmt.Errorf("gitlab: decode list merge requests response: %w", err)
	}
	out := make([]domain.MergeRequest, 0, len(raw))
	for _, gm := range raw {
		out = append(out, toDomainMergeRequest(repo, gm))
	}
	return out, nil
}

// ResolveDiscussion calls GitLab's REST API: PUT
// /projects/{id}/merge_requests/{iid}/discussions/{discussion_id}?resolved={bool}.
func (c *Client) ResolveDiscussion(ctx context.Context, cred usecase.Credential, repo string, mrIID int32, discussionID string, resolved bool) (domain.MergeRequestDiscussion, error) {
	reqURL := fmt.Sprintf("%s/projects/%s/merge_requests/%d/discussions/%s?resolved=%t",
		c.baseURL, projectPath(repo), mrIID, url.PathEscape(discussionID), resolved)
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, reqURL, nil)
	if err != nil {
		return domain.MergeRequestDiscussion{}, fmt.Errorf("gitlab: build resolve discussion request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+cred.Token)
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return domain.MergeRequestDiscussion{}, fmt.Errorf("gitlab: resolve discussion request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return domain.MergeRequestDiscussion{}, fmt.Errorf("gitlab: resolve discussion: unexpected status %d", resp.StatusCode)
	}
	var raw struct {
		ID    string `json:"id"`
		Notes []struct {
			Resolved   bool `json:"resolved"`
			ResolvedBy struct {
				Username string `json:"username"`
			} `json:"resolved_by"`
		} `json:"notes"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return domain.MergeRequestDiscussion{}, fmt.Errorf("gitlab: decode resolve discussion response: %w", err)
	}
	disc := domain.MergeRequestDiscussion{ID: raw.ID, Resolved: resolved}
	if len(raw.Notes) > 0 {
		disc.Resolved = raw.Notes[0].Resolved
		disc.ResolvedBy = raw.Notes[0].ResolvedBy.Username
	}
	return disc, nil
}

// GetWorkItemDetails calls GitLab's REST API: GET
// /projects/{id}/merge_requests/{iid} or /projects/{id}/issues/{iid},
// selected by itemType — GitLab addresses issues and MRs by separate iid
// sequences, not a shared "work item" ID space.
func (c *Client) GetWorkItemDetails(ctx context.Context, cred usecase.Credential, repo string, iid int32, itemType string) (domain.WorkItemDetailsGitLab, error) {
	segment := "merge_requests"
	if itemType == "issue" {
		segment = "issues"
	}
	reqURL := fmt.Sprintf("%s/projects/%s/%s/%d", c.baseURL, projectPath(repo), segment, iid)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return domain.WorkItemDetailsGitLab{}, fmt.Errorf("gitlab: build get work item details request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+cred.Token)
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return domain.WorkItemDetailsGitLab{}, fmt.Errorf("gitlab: get work item details request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return domain.WorkItemDetailsGitLab{}, fmt.Errorf("gitlab: get work item details: unexpected status %d", resp.StatusCode)
	}
	var raw struct {
		ID          int      `json:"id"`
		IID         int      `json:"iid"`
		Title       string   `json:"title"`
		Description string   `json:"description"`
		State       string   `json:"state"`
		WebURL      string   `json:"web_url"`
		Labels      []string `json:"labels"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return domain.WorkItemDetailsGitLab{}, fmt.Errorf("gitlab: decode get work item details response: %w", err)
	}
	return domain.WorkItemDetailsGitLab{
		ID: strconv.Itoa(raw.ID), IID: int32(raw.IID), ItemType: itemType,
		Title: raw.Title, Body: raw.Description, State: raw.State, URL: raw.WebURL, Labels: raw.Labels,
	}, nil
}
