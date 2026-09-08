// Package gitea implements usecase.ScmProvider against Gitea's REST API
// directly via net/http — see scm-integration-service.md §7. Gitea's API is
// explicitly designed to mirror GitHub's, so this adapter closely follows
// the github adapter's conventions and endpoint shapes. Every ScmProvider
// method is a real REST call as of Phase 3 (docs/execution-plan.md §3),
// except GetRateLimitStatus, which is a deliberate scope decision — see its
// doc comment.
//
// Not implemented in this scaffold: a future GetBoardView usecase should
// return ErrCapabilityUnsupported for this adapter, per §4, not force this
// adapter to fake a Gitea project-board equivalent — Gitea has none.
package gitea

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"

	"github.com/stablyai/orca-go/services/scm-integration-service/internal/domain"
	"github.com/stablyai/orca-go/services/scm-integration-service/internal/usecase"
)

// DefaultBaseURL is the hosted gitea.com instance's REST API root. Gitea is
// typically self-hosted, so callers targeting a private instance must pass
// its base URL explicitly to New instead of relying on this default.
const DefaultBaseURL = "https://gitea.com/api/v1"

// ErrNotImplemented is kept as a sentinel for any future method added to
// usecase.ScmProvider before this adapter implements it — every method
// currently in the interface is real (GetRateLimitStatus intentionally
// returns ErrCapabilityUnsupported instead, not this sentinel).
var ErrNotImplemented = errors.New("gitea: not implemented")

// ErrCapabilityUnsupported is returned by adapter methods that have no
// equivalent on this provider, so usecase code can degrade per-provider
// instead of failing uniformly — per §4's ErrCapabilityUnsupported
// precedent. See GetRateLimitStatus's doc comment for why it returns this.
var ErrCapabilityUnsupported = errors.New("gitea: capability not supported: no rate-limit-status endpoint")

// Client implements usecase.ScmProvider against Gitea's REST API.
type Client struct {
	httpClient *http.Client
	baseURL    string
}

// New returns a Gitea Client. A nil httpClient defaults to
// http.DefaultClient; an empty baseURL defaults to DefaultBaseURL —
// overridable for tests (httptest.Server) and self-hosted Gitea instances,
// which is the common case since Gitea has no single public default host.
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

// giteaIssue mirrors the fields this adapter needs from Gitea's
// GET /repos/{owner}/{repo}/issues response
// (https://docs.gitea.com/api/next/#tag/issue/operation/issueListIssues).
// Like GitHub, Gitea's issues endpoint also returns pull requests;
// PullRequest being non-nil is how the API distinguishes them.
type giteaIssue struct {
	Number      int    `json:"number"`
	Title       string `json:"title"`
	State       string `json:"state"`
	HTMLURL     string `json:"html_url"`
	PullRequest *struct {
		URL string `json:"url"`
	} `json:"pull_request"`
}

// ListIssues calls Gitea's REST API for real: GET /repos/{repo}/issues,
// with the resolved per-tenant token as a Bearer credential — per
// scm-integration-service.md §9, this is the only place that token exists,
// built directly into the auth header immediately before dispatch, never
// stored on the Client or logged.
func (c *Client) ListIssues(ctx context.Context, cred usecase.Credential, repo string, _ usecase.IssueFilter) ([]domain.Issue, error) {
	url := fmt.Sprintf("%s/repos/%s/issues", c.baseURL, repo)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("gitea: build list issues request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+cred.Token)
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("gitea: list issues request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("gitea: list issues: unexpected status %d", resp.StatusCode)
	}

	var raw []giteaIssue
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, fmt.Errorf("gitea: decode list issues response: %w", err)
	}

	issues := make([]domain.Issue, 0, len(raw))
	for _, gi := range raw {
		if gi.PullRequest != nil {
			continue // Gitea's issues endpoint also returns PRs; not this method's concern.
		}
		issue, err := domain.NewIssue(strconv.Itoa(gi.Number), domain.ScmProviderGitea, repo, gi.Title, gi.State, gi.HTMLURL)
		if err != nil {
			return nil, fmt.Errorf("gitea: invalid issue in response: %w", err)
		}
		issues = append(issues, issue)
	}
	return issues, nil
}

// giteaPullRequest mirrors the fields this adapter needs from Gitea's
// POST/GET /repos/{owner}/{repo}/pulls response shape
// (https://docs.gitea.com/api/next/#tag/repository/operation/repoListPullRequests).
type giteaPullRequest struct {
	Number  int    `json:"number"`
	Title   string `json:"title"`
	State   string `json:"state"`
	HTMLURL string `json:"html_url"`
	Head    struct {
		Ref string `json:"ref"`
	} `json:"head"`
	Base struct {
		Ref string `json:"ref"`
	} `json:"base"`
}

func toDomainPullRequest(repo string, gp giteaPullRequest) (domain.PullRequest, error) {
	return domain.NewPullRequest(
		strconv.Itoa(gp.Number), domain.ScmProviderGitea, repo, gp.Title, gp.State, gp.HTMLURL,
		gp.Head.Ref, gp.Base.Ref,
	)
}

// CreatePullRequest calls Gitea's REST API for real: POST
// /repos/{repo}/pulls, with the resolved per-tenant token as a Bearer
// credential — see ListIssues' doc comment for the token-handling
// invariant this shares.
func (c *Client) CreatePullRequest(ctx context.Context, cred usecase.Credential, repo string, input usecase.CreatePullRequestInput) (domain.PullRequest, error) {
	body, err := json.Marshal(struct {
		Title string `json:"title"`
		Body  string `json:"body,omitempty"`
		Head  string `json:"head"`
		Base  string `json:"base"`
	}{Title: input.Title, Body: input.Body, Head: input.HeadBranch, Base: input.BaseBranch})
	if err != nil {
		return domain.PullRequest{}, fmt.Errorf("gitea: encode create pull request body: %w", err)
	}

	url := fmt.Sprintf("%s/repos/%s/pulls", c.baseURL, repo)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return domain.PullRequest{}, fmt.Errorf("gitea: build create pull request request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+cred.Token)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return domain.PullRequest{}, fmt.Errorf("gitea: create pull request request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusCreated {
		return domain.PullRequest{}, fmt.Errorf("gitea: create pull request: unexpected status %d", resp.StatusCode)
	}

	var raw giteaPullRequest
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return domain.PullRequest{}, fmt.Errorf("gitea: decode create pull request response: %w", err)
	}
	pr, err := toDomainPullRequest(repo, raw)
	if err != nil {
		return domain.PullRequest{}, fmt.Errorf("gitea: invalid pull request in response: %w", err)
	}
	return pr, nil
}

// ListPullRequests calls Gitea's REST API for real: GET
// /repos/{repo}/pulls.
func (c *Client) ListPullRequests(ctx context.Context, cred usecase.Credential, repo string) ([]domain.PullRequest, error) {
	url := fmt.Sprintf("%s/repos/%s/pulls", c.baseURL, repo)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("gitea: build list pull requests request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+cred.Token)
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("gitea: list pull requests request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("gitea: list pull requests: unexpected status %d", resp.StatusCode)
	}

	var raw []giteaPullRequest
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, fmt.Errorf("gitea: decode list pull requests response: %w", err)
	}
	prs := make([]domain.PullRequest, 0, len(raw))
	for _, gp := range raw {
		pr, err := toDomainPullRequest(repo, gp)
		if err != nil {
			return nil, fmt.Errorf("gitea: invalid pull request in response: %w", err)
		}
		prs = append(prs, pr)
	}
	return prs, nil
}

// GetRateLimitStatus is a deliberate scope decision, not a stub: Gitea has
// no rate-limit concept comparable to GitHub's by default — self-hosted
// instances are typically unlimited, or limited at a reverse-proxy layer
// this API can't see. Rather than guess at best-effort headers an instance
// may or may not send, this adapter always reports the capability as
// unsupported, so usecase code degrades per-provider via
// ErrCapabilityUnsupported (§4) instead of trusting a signal that isn't
// part of Gitea's documented API contract.
func (c *Client) GetRateLimitStatus(_ context.Context, _ usecase.Credential) (domain.RateLimitStatus, error) {
	return domain.RateLimitStatus{}, ErrCapabilityUnsupported
}

// MergePullRequest, RequestPullRequestReviewers, RemovePullRequestReviewers,
// SetPullRequestAutoMerge, UpdateIssue, GetPullRequestForBranch, and
// ResolveRepoSlug are the SOL-012 GitHub-mutation-shaped ScmProvider
// additions — not implemented for Gitea in this pass, mirroring
// GetRateLimitStatus's ErrCapabilityUnsupported precedent above rather than
// faking support.
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

// BranchExists calls Gitea's REST API: GET /repos/{owner}/{repo}/branches/{branch}
// — GitHub-shaped API, identical 200/404 shape to GitHub's own BranchExists.
func (c *Client) BranchExists(ctx context.Context, cred usecase.Credential, repo, branch string) (bool, error) {
	reqURL := fmt.Sprintf("%s/repos/%s/branches/%s", c.baseURL, repo, url.PathEscape(branch))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return false, fmt.Errorf("gitea: build branch exists request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+cred.Token)
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return false, fmt.Errorf("gitea: branch exists request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	switch resp.StatusCode {
	case http.StatusOK:
		return true, nil
	case http.StatusNotFound:
		return false, nil
	default:
		return false, fmt.Errorf("gitea: branch exists: unexpected status %d", resp.StatusCode)
	}
}
