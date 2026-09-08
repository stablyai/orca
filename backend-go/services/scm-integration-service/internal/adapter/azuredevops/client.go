// Package azuredevops implements usecase.ScmProvider against Azure DevOps
// Services' REST API (https://dev.azure.com) directly via net/http — mirrors
// internal/adapter/github's structure, the reference implementation the
// other provider adapters follow. Three of the four ScmProvider methods are
// real REST calls; ListIssues is deliberately unimplemented — see its doc
// comment.
package azuredevops

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/stablyai/orca-go/services/scm-integration-service/internal/domain"
	"github.com/stablyai/orca-go/services/scm-integration-service/internal/usecase"
)

// DefaultBaseURL is Azure DevOps Services' public REST API root.
const DefaultBaseURL = "https://dev.azure.com"

// apiVersion pins every request to a recent stable GA version of Azure
// DevOps' REST API — required as a query parameter on every call.
const apiVersion = "7.1"

// ErrNotImplemented is kept as a sentinel for any future method added to
// usecase.ScmProvider before this adapter implements it.
var ErrNotImplemented = errors.New("azuredevops: not implemented")

// ErrCapabilityUnsupported is returned by ListIssues: Azure DevOps has no
// native "Issues" concept the way GitHub/GitLab/Bitbucket do — work items
// (Bugs/Tasks/User Stories via WIQL queries) are the closest analog, but
// mapping arbitrary work-item types onto this scaffold's simple domain.Issue
// shape is out of scope for this pass — see scm-integration-service.md §4.
var ErrCapabilityUnsupported = errors.New("azuredevops: capability not supported: no native issue-tracking concept, see work items")

// Client implements usecase.ScmProvider against Azure DevOps' REST API.
type Client struct {
	httpClient *http.Client
	baseURL    string
}

// New returns an Azure DevOps Client. A nil httpClient defaults to
// http.DefaultClient; an empty baseURL defaults to DefaultBaseURL —
// overridable for tests (httptest.Server).
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

// splitRepo parses this adapter's "org/project/repositoryId" repo
// convention (Azure DevOps has no single "owner/repo" pair — it nests
// repositories under a project under an organization).
func splitRepo(repo string) (org, project, repositoryID string, err error) {
	parts := strings.Split(repo, "/")
	if len(parts) != 3 {
		return "", "", "", fmt.Errorf("azuredevops: repo must be \"org/project/repositoryId\", got %q", repo)
	}
	return parts[0], parts[1], parts[2], nil
}

// ListIssues is unimplemented by design, not by omission: Azure DevOps has
// no native issue-tracking concept, only work items — a different, more
// complex, heavily-typed system this scaffold's simple domain.Issue shape
// can't represent. Per scm-integration-service.md §4, a provider that
// doesn't support an operation returns typed ErrCapabilityUnsupported.
func (c *Client) ListIssues(_ context.Context, _ usecase.Credential, _ string, _ usecase.IssueFilter) ([]domain.Issue, error) {
	return nil, ErrCapabilityUnsupported
}

// azureDevOpsPullRequest mirrors the fields this adapter needs from Azure
// DevOps' pull request response shape
// (https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests).
type azureDevOpsPullRequest struct {
	PullRequestID int    `json:"pullRequestId"`
	Title         string `json:"title"`
	Status        string `json:"status"`
	SourceRefName string `json:"sourceRefName"`
	TargetRefName string `json:"targetRefName"`
}

// azureDevOpsPullRequestList mirrors Azure DevOps' list response envelope —
// wrapped in {value, count}, not a bare array like GitHub's.
type azureDevOpsPullRequestList struct {
	Value []azureDevOpsPullRequest `json:"value"`
	Count int                      `json:"count"`
}

// toDomainPullRequest maps one Azure DevOps pull request onto the
// provider-agnostic domain shape. Azure DevOps' response has no direct HTML
// URL field, so the browsable URL is constructed from the org/project/repo
// path segments and the pull request ID.
func toDomainPullRequest(org, project, repositoryID, repo string, ap azureDevOpsPullRequest) (domain.PullRequest, error) {
	url := fmt.Sprintf("https://dev.azure.com/%s/%s/_git/%s/pullrequest/%d", org, project, repositoryID, ap.PullRequestID)
	return domain.NewPullRequest(
		strconv.Itoa(ap.PullRequestID), domain.ScmProviderAzureDevOps, repo, ap.Title, ap.Status, url,
		strings.TrimPrefix(ap.SourceRefName, "refs/heads/"), strings.TrimPrefix(ap.TargetRefName, "refs/heads/"),
	)
}

// CreatePullRequest calls Azure DevOps' REST API for real: POST
// {org}/{project}/_apis/git/repositories/{repositoryId}/pullrequests, with
// the resolved per-tenant token as a Bearer credential — per
// scm-integration-service.md §9, this is the only place that token exists,
// built directly into the auth header immediately before dispatch, never
// stored on the Client or logged.
func (c *Client) CreatePullRequest(ctx context.Context, cred usecase.Credential, repo string, input usecase.CreatePullRequestInput) (domain.PullRequest, error) {
	org, project, repositoryID, err := splitRepo(repo)
	if err != nil {
		return domain.PullRequest{}, err
	}

	body, err := json.Marshal(struct {
		Title         string `json:"title"`
		Description   string `json:"description,omitempty"`
		SourceRefName string `json:"sourceRefName"`
		TargetRefName string `json:"targetRefName"`
	}{
		Title:         input.Title,
		Description:   input.Body,
		SourceRefName: "refs/heads/" + input.HeadBranch,
		TargetRefName: "refs/heads/" + input.BaseBranch,
	})
	if err != nil {
		return domain.PullRequest{}, fmt.Errorf("azuredevops: encode create pull request body: %w", err)
	}

	url := fmt.Sprintf("%s/%s/%s/_apis/git/repositories/%s/pullrequests?api-version=%s", c.baseURL, org, project, repositoryID, apiVersion)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return domain.PullRequest{}, fmt.Errorf("azuredevops: build create pull request request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+cred.Token)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return domain.PullRequest{}, fmt.Errorf("azuredevops: create pull request request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusCreated {
		return domain.PullRequest{}, fmt.Errorf("azuredevops: create pull request: unexpected status %d", resp.StatusCode)
	}

	var raw azureDevOpsPullRequest
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return domain.PullRequest{}, fmt.Errorf("azuredevops: decode create pull request response: %w", err)
	}
	pr, err := toDomainPullRequest(org, project, repositoryID, repo, raw)
	if err != nil {
		return domain.PullRequest{}, fmt.Errorf("azuredevops: invalid pull request in response: %w", err)
	}
	return pr, nil
}

// ListPullRequests calls Azure DevOps' REST API for real: GET
// {org}/{project}/_apis/git/repositories/{repositoryId}/pullrequests.
func (c *Client) ListPullRequests(ctx context.Context, cred usecase.Credential, repo string) ([]domain.PullRequest, error) {
	org, project, repositoryID, err := splitRepo(repo)
	if err != nil {
		return nil, err
	}

	url := fmt.Sprintf("%s/%s/%s/_apis/git/repositories/%s/pullrequests?api-version=%s", c.baseURL, org, project, repositoryID, apiVersion)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("azuredevops: build list pull requests request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+cred.Token)
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("azuredevops: list pull requests request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("azuredevops: list pull requests: unexpected status %d", resp.StatusCode)
	}

	var raw azureDevOpsPullRequestList
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, fmt.Errorf("azuredevops: decode list pull requests response: %w", err)
	}
	prs := make([]domain.PullRequest, 0, len(raw.Value))
	for _, ap := range raw.Value {
		pr, err := toDomainPullRequest(org, project, repositoryID, repo, ap)
		if err != nil {
			return nil, fmt.Errorf("azuredevops: invalid pull request in response: %w", err)
		}
		prs = append(prs, pr)
	}
	return prs, nil
}

// GetRateLimitStatus makes a lightweight authenticated GET request to
// _apis/projects (the cheapest real endpoint) and reads Azure DevOps'
// throttling headers off the response — TFS/Azure DevOps Services
// communicate rate limiting via X-RateLimit-* response headers, not a
// dedicated endpoint like GitHub's /rate_limit.
//
// DEVIATION: usecase.ScmProvider.GetRateLimitStatus takes no repo/org
// parameter, so unlike CreatePullRequest/ListPullRequests (which derive
// {org} from the repo string) this call cannot address
// https://dev.azure.com/{org}/_apis/projects for an arbitrary org — it hits
// {baseURL}/_apis/projects instead. A real deployment would need baseURL
// configured per-org (e.g. "https://dev.azure.com/{org}") for this method to
// resolve to a real org, or the interface extended with an org/repo
// parameter; flagged here rather than silently guessed.
func (c *Client) GetRateLimitStatus(ctx context.Context, cred usecase.Credential) (domain.RateLimitStatus, error) {
	url := fmt.Sprintf("%s/_apis/projects?api-version=%s&$top=1", c.baseURL, apiVersion)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return domain.RateLimitStatus{}, fmt.Errorf("azuredevops: build rate limit request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+cred.Token)
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return domain.RateLimitStatus{}, fmt.Errorf("azuredevops: rate limit request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		return domain.RateLimitStatus{}, fmt.Errorf("azuredevops: rate limit: unexpected status %d", resp.StatusCode)
	}

	// Headers are absent when the service isn't throttling this credential
	// yet — a zero-value status (not an error) is the correct read in that
	// case, mirroring bitbucket's defensive header parsing.
	status := domain.RateLimitStatus{Provider: domain.ScmProviderAzureDevOps}
	if limit, err := strconv.Atoi(resp.Header.Get("X-RateLimit-Limit")); err == nil {
		status.Limit = limit
	}
	if remaining, err := strconv.Atoi(resp.Header.Get("X-RateLimit-Remaining")); err == nil {
		status.Remaining = remaining
	}
	if reset, err := strconv.ParseInt(resp.Header.Get("X-RateLimit-Reset"), 10, 64); err == nil {
		status.ResetAt = time.Unix(reset, 0)
	}
	return status, nil
}

// MergePullRequest, RequestPullRequestReviewers, RemovePullRequestReviewers,
// SetPullRequestAutoMerge, UpdateIssue, GetPullRequestForBranch, and
// ResolveRepoSlug are the SOL-012 GitHub-mutation-shaped ScmProvider
// additions — not implemented for Azure DevOps in this pass, mirroring
// ListIssues' ErrCapabilityUnsupported precedent above rather than faking
// support.
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

// azureDevOpsRefList mirrors Azure DevOps' GET .../refs?filter=heads/{branch}
// response envelope — {value: [...], count}. Azure DevOps always returns 200
// for this endpoint; branch existence is len(value) > 0, not the status
// code, unlike GitHub/GitLab/Bitbucket/Gitea's 200-vs-404 convention.
type azureDevOpsRefList struct {
	Value []struct {
		Name string `json:"name"`
	} `json:"value"`
	Count int `json:"count"`
}

// BranchExists calls Azure DevOps' REST API: GET
// {org}/{project}/_apis/git/repositories/{repositoryId}/refs?filter=heads/{branch}.
func (c *Client) BranchExists(ctx context.Context, cred usecase.Credential, repo, branch string) (bool, error) {
	org, project, repositoryID, err := splitRepo(repo)
	if err != nil {
		return false, err
	}
	reqURL := fmt.Sprintf("%s/%s/%s/_apis/git/repositories/%s/refs?filter=%s&api-version=%s",
		c.baseURL, org, project, repositoryID, url.QueryEscape("heads/"+branch), apiVersion)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return false, fmt.Errorf("azuredevops: build branch exists request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+cred.Token)
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return false, fmt.Errorf("azuredevops: branch exists request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return false, fmt.Errorf("azuredevops: branch exists: unexpected status %d", resp.StatusCode)
	}
	var raw azureDevOpsRefList
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return false, fmt.Errorf("azuredevops: decode branch exists response: %w", err)
	}
	return len(raw.Value) > 0, nil
}
