// Package github implements usecase.ScmProvider against GitHub's REST API
// directly via net/http — no gh CLI, no shared keychain, no shell-out, per
// scm-integration-service.md §10 (the direct fix for TS Gap 1). Every
// ScmProvider method is a real REST call as of Phase 3
// (docs/execution-plan.md §3) — this is the reference implementation the
// other four provider adapters mirror.
package github

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

// DefaultBaseURL is GitHub's public REST API root.
const DefaultBaseURL = "https://api.github.com"

// DefaultGraphQLURL is GitHub's single GraphQL endpoint — distinct from
// DefaultBaseURL's REST root. GitHub Enterprise Server deployments use
// {baseURL}/api/graphql instead; not handled here since this adapter only
// targets github.com today (same scope limitation client.go already has
// for DefaultBaseURL).
const DefaultGraphQLURL = "https://api.github.com/graphql"

// ErrNotImplemented is kept as a sentinel for any future method added to
// usecase.ScmProvider before this adapter implements it — every method
// currently in the interface is real.
var ErrNotImplemented = errors.New("github: not implemented")

// Client implements usecase.ScmProvider against GitHub's REST API.
type Client struct {
	httpClient *http.Client
	baseURL    string
	graphQLURL string
}

// New returns a GitHub Client. A nil httpClient defaults to
// http.DefaultClient; an empty baseURL defaults to DefaultBaseURL —
// overridable for tests (httptest.Server) and GitHub Enterprise deployments.
func New(httpClient *http.Client, baseURL string) *Client {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	return &Client{httpClient: httpClient, baseURL: baseURL, graphQLURL: DefaultGraphQLURL}
}

var _ usecase.ScmProvider = (*Client)(nil)

// githubIssue mirrors the fields this adapter needs from GitHub's
// GET /repos/{owner}/{repo}/issues response
// (https://docs.github.com/en/rest/issues/issues#list-repository-issues).
// GitHub's issues endpoint also returns pull requests; PullRequest being
// non-nil is how the API distinguishes them.
type githubIssue struct {
	Number      int    `json:"number"`
	Title       string `json:"title"`
	State       string `json:"state"`
	HTMLURL     string `json:"html_url"`
	PullRequest *struct {
		URL string `json:"url"`
	} `json:"pull_request"`
}

// ListIssues calls GitHub's REST API for real: GET /repos/{repo}/issues,
// with the resolved per-tenant token as a Bearer credential — per
// scm-integration-service.md §9, this is the only place that token exists,
// built directly into the auth header immediately before dispatch, never
// stored on the Client or logged.
func (c *Client) ListIssues(ctx context.Context, cred usecase.Credential, repo string, _ usecase.IssueFilter) ([]domain.Issue, error) {
	url := fmt.Sprintf("%s/repos/%s/issues", c.baseURL, repo)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("github: build list issues request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+cred.Token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("github: list issues request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("github: list issues: unexpected status %d", resp.StatusCode)
	}

	var raw []githubIssue
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, fmt.Errorf("github: decode list issues response: %w", err)
	}

	issues := make([]domain.Issue, 0, len(raw))
	for _, gi := range raw {
		if gi.PullRequest != nil {
			continue // GitHub's issues endpoint also returns PRs; not this method's concern.
		}
		issue, err := domain.NewIssue(strconv.Itoa(gi.Number), domain.ScmProviderGitHub, repo, gi.Title, gi.State, gi.HTMLURL)
		if err != nil {
			return nil, fmt.Errorf("github: invalid issue in response: %w", err)
		}
		issues = append(issues, issue)
	}
	return issues, nil
}

// githubPullRequest mirrors the fields this adapter needs from GitHub's
// POST/GET /repos/{owner}/{repo}/pulls response shape
// (https://docs.github.com/en/rest/pulls/pulls).
type githubPullRequest struct {
	Number  int    `json:"number"`
	NodeID  string `json:"node_id"` // GraphQL node id — needed by SetPullRequestAutoMerge's mutation
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

func toDomainPullRequest(repo string, gp githubPullRequest) (domain.PullRequest, error) {
	pr, err := domain.NewPullRequest(
		strconv.Itoa(gp.Number), domain.ScmProviderGitHub, repo, gp.Title, gp.State, gp.HTMLURL,
		gp.Head.Ref, gp.Base.Ref,
	)
	if err != nil {
		return domain.PullRequest{}, err
	}
	pr.Number = int32(gp.Number)
	return pr, nil
}

// CreatePullRequest calls GitHub's REST API for real: POST
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
		return domain.PullRequest{}, fmt.Errorf("github: encode create pull request body: %w", err)
	}

	url := fmt.Sprintf("%s/repos/%s/pulls", c.baseURL, repo)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return domain.PullRequest{}, fmt.Errorf("github: build create pull request request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+cred.Token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return domain.PullRequest{}, fmt.Errorf("github: create pull request request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusCreated {
		return domain.PullRequest{}, fmt.Errorf("github: create pull request: unexpected status %d", resp.StatusCode)
	}

	var raw githubPullRequest
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return domain.PullRequest{}, fmt.Errorf("github: decode create pull request response: %w", err)
	}
	pr, err := toDomainPullRequest(repo, raw)
	if err != nil {
		return domain.PullRequest{}, fmt.Errorf("github: invalid pull request in response: %w", err)
	}
	return pr, nil
}

// ListPullRequests calls GitHub's REST API for real: GET
// /repos/{repo}/pulls.
func (c *Client) ListPullRequests(ctx context.Context, cred usecase.Credential, repo string) ([]domain.PullRequest, error) {
	url := fmt.Sprintf("%s/repos/%s/pulls", c.baseURL, repo)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("github: build list pull requests request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+cred.Token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("github: list pull requests request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("github: list pull requests: unexpected status %d", resp.StatusCode)
	}

	var raw []githubPullRequest
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, fmt.Errorf("github: decode list pull requests response: %w", err)
	}
	prs := make([]domain.PullRequest, 0, len(raw))
	for _, gp := range raw {
		pr, err := toDomainPullRequest(repo, gp)
		if err != nil {
			return nil, fmt.Errorf("github: invalid pull request in response: %w", err)
		}
		prs = append(prs, pr)
	}
	return prs, nil
}

// githubRateLimitResponse mirrors GET /rate_limit
// (https://docs.github.com/en/rest/rate-limit) — this adapter reports the
// "core" REST bucket, since that's the bucket every other method in this
// client consumes against; GraphQL/search buckets are a separate future
// RateLimitStatus.Bucket dimension per §8, not modeled yet.
type githubRateLimitResponse struct {
	Resources struct {
		Core struct {
			Limit     int   `json:"limit"`
			Remaining int   `json:"remaining"`
			Reset     int64 `json:"reset"`
		} `json:"core"`
	} `json:"resources"`
}

// GetRateLimitStatus calls GitHub's REST API for real: GET /rate_limit.
func (c *Client) GetRateLimitStatus(ctx context.Context, cred usecase.Credential) (domain.RateLimitStatus, error) {
	url := fmt.Sprintf("%s/rate_limit", c.baseURL)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return domain.RateLimitStatus{}, fmt.Errorf("github: build rate limit request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+cred.Token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return domain.RateLimitStatus{}, fmt.Errorf("github: rate limit request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		return domain.RateLimitStatus{}, fmt.Errorf("github: rate limit: unexpected status %d", resp.StatusCode)
	}

	var raw githubRateLimitResponse
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return domain.RateLimitStatus{}, fmt.Errorf("github: decode rate limit response: %w", err)
	}
	return domain.RateLimitStatus{
		Provider:  domain.ScmProviderGitHub,
		Remaining: raw.Resources.Core.Remaining,
		Limit:     raw.Resources.Core.Limit,
		ResetAt:   time.Unix(raw.Resources.Core.Reset, 0),
	}, nil
}

// getPullRequestByNumber calls GET /repos/{repo}/pulls/{number} — used by
// every mutation below to return the post-mutation PR state, since GitHub's
// mutation endpoints (merge, requested_reviewers) don't always echo every
// field this adapter's domain.PullRequest needs.
func (c *Client) getPullRequestByNumber(ctx context.Context, cred usecase.Credential, repo string, number int32) (githubPullRequest, error) {
	reqURL := fmt.Sprintf("%s/repos/%s/pulls/%d", c.baseURL, repo, number)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return githubPullRequest{}, fmt.Errorf("github: build get pull request request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+cred.Token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return githubPullRequest{}, fmt.Errorf("github: get pull request request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return githubPullRequest{}, fmt.Errorf("github: get pull request: unexpected status %d", resp.StatusCode)
	}
	var raw githubPullRequest
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return githubPullRequest{}, fmt.Errorf("github: decode get pull request response: %w", err)
	}
	return raw, nil
}

// MergePullRequest calls GitHub's REST API: PUT /repos/{repo}/pulls/{number}/merge.
func (c *Client) MergePullRequest(ctx context.Context, cred usecase.Credential, repo string, number int32, input usecase.MergePullRequestInput) (domain.PullRequest, bool, string, error) {
	body, err := json.Marshal(struct {
		MergeMethod   string `json:"merge_method,omitempty"`
		CommitTitle   string `json:"commit_title,omitempty"`
		CommitMessage string `json:"commit_message,omitempty"`
	}{MergeMethod: input.MergeMethod, CommitTitle: input.CommitTitle, CommitMessage: input.CommitMessage})
	if err != nil {
		return domain.PullRequest{}, false, "", fmt.Errorf("github: encode merge pull request body: %w", err)
	}

	reqURL := fmt.Sprintf("%s/repos/%s/pulls/%d/merge", c.baseURL, repo, number)
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, reqURL, bytes.NewReader(body))
	if err != nil {
		return domain.PullRequest{}, false, "", fmt.Errorf("github: build merge pull request request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+cred.Token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return domain.PullRequest{}, false, "", fmt.Errorf("github: merge pull request request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return domain.PullRequest{}, false, "", fmt.Errorf("github: merge pull request: unexpected status %d", resp.StatusCode)
	}

	var raw struct {
		Merged  bool   `json:"merged"`
		SHA     string `json:"sha"`
		Message string `json:"message"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return domain.PullRequest{}, false, "", fmt.Errorf("github: decode merge pull request response: %w", err)
	}

	gp, err := c.getPullRequestByNumber(ctx, cred, repo, number)
	if err != nil {
		return domain.PullRequest{}, raw.Merged, raw.SHA, fmt.Errorf("github: refetch merged pull request: %w", err)
	}
	pr, err := toDomainPullRequest(repo, gp)
	if err != nil {
		return domain.PullRequest{}, raw.Merged, raw.SHA, fmt.Errorf("github: invalid pull request after merge: %w", err)
	}
	return pr, raw.Merged, raw.SHA, nil
}

// RequestPullRequestReviewers calls GitHub's REST API: POST
// /repos/{repo}/pulls/{number}/requested_reviewers.
func (c *Client) RequestPullRequestReviewers(ctx context.Context, cred usecase.Credential, repo string, number int32, reviewerLogins, teamSlugs []string) (domain.PullRequest, error) {
	body, err := json.Marshal(struct {
		Reviewers     []string `json:"reviewers,omitempty"`
		TeamReviewers []string `json:"team_reviewers,omitempty"`
	}{Reviewers: reviewerLogins, TeamReviewers: teamSlugs})
	if err != nil {
		return domain.PullRequest{}, fmt.Errorf("github: encode request reviewers body: %w", err)
	}
	reqURL := fmt.Sprintf("%s/repos/%s/pulls/%d/requested_reviewers", c.baseURL, repo, number)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, reqURL, bytes.NewReader(body))
	if err != nil {
		return domain.PullRequest{}, fmt.Errorf("github: build request reviewers request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+cred.Token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return domain.PullRequest{}, fmt.Errorf("github: request reviewers request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusCreated {
		return domain.PullRequest{}, fmt.Errorf("github: request reviewers: unexpected status %d", resp.StatusCode)
	}
	var raw githubPullRequest
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return domain.PullRequest{}, fmt.Errorf("github: decode request reviewers response: %w", err)
	}
	return toDomainPullRequest(repo, raw)
}

// RemovePullRequestReviewers calls GitHub's REST API: DELETE
// /repos/{repo}/pulls/{number}/requested_reviewers (DELETE with a JSON body
// is valid per GitHub's API; net/http supports a body on DELETE requests).
func (c *Client) RemovePullRequestReviewers(ctx context.Context, cred usecase.Credential, repo string, number int32, reviewerLogins []string) (domain.PullRequest, error) {
	body, err := json.Marshal(struct {
		Reviewers []string `json:"reviewers"`
	}{Reviewers: reviewerLogins})
	if err != nil {
		return domain.PullRequest{}, fmt.Errorf("github: encode remove reviewers body: %w", err)
	}
	reqURL := fmt.Sprintf("%s/repos/%s/pulls/%d/requested_reviewers", c.baseURL, repo, number)
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, reqURL, bytes.NewReader(body))
	if err != nil {
		return domain.PullRequest{}, fmt.Errorf("github: build remove reviewers request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+cred.Token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return domain.PullRequest{}, fmt.Errorf("github: remove reviewers request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return domain.PullRequest{}, fmt.Errorf("github: remove reviewers: unexpected status %d", resp.StatusCode)
	}
	var raw githubPullRequest
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return domain.PullRequest{}, fmt.Errorf("github: decode remove reviewers response: %w", err)
	}
	return toDomainPullRequest(repo, raw)
}

// graphQLRequest POSTs one GraphQL operation to GitHub's /graphql endpoint
// and decodes the "data" field into out. GitHub reports GraphQL-level
// errors in a 200-status "errors" array (distinct from REST's status-code
// error convention) — both are treated as failures here.
func (c *Client) graphQLRequest(ctx context.Context, cred usecase.Credential, query string, variables map[string]any, out any) error {
	body, err := json.Marshal(struct {
		Query     string         `json:"query"`
		Variables map[string]any `json:"variables"`
	}{Query: query, Variables: variables})
	if err != nil {
		return fmt.Errorf("github: encode graphql request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.graphQLURL, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("github: build graphql request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+cred.Token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("github: graphql request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("github: graphql: unexpected status %d", resp.StatusCode)
	}

	var raw struct {
		Data   json.RawMessage `json:"data"`
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return fmt.Errorf("github: decode graphql response: %w", err)
	}
	if len(raw.Errors) > 0 {
		return fmt.Errorf("github: graphql error: %s", raw.Errors[0].Message)
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(raw.Data, out); err != nil {
		return fmt.Errorf("github: decode graphql data: %w", err)
	}
	return nil
}

// SetPullRequestAutoMerge calls GitHub's GraphQL API — REST has no
// auto-merge endpoint. Resolves the PR's GraphQL node id via REST first
// (enablePullRequestAutoMerge/disablePullRequestAutoMerge take a node id,
// not a repo+number pair).
func (c *Client) SetPullRequestAutoMerge(ctx context.Context, cred usecase.Credential, repo string, number int32, enabled bool, mergeMethod string) (domain.PullRequest, error) {
	gp, err := c.getPullRequestByNumber(ctx, cred, repo, number)
	if err != nil {
		return domain.PullRequest{}, fmt.Errorf("github: resolve pull request node id: %w", err)
	}

	if enabled {
		const mutation = `mutation($id: ID!, $mergeMethod: PullRequestMergeMethod!) {
			enablePullRequestAutoMerge(input: {pullRequestId: $id, mergeMethod: $mergeMethod}) {
				pullRequest { id }
			}
		}`
		if err := c.graphQLRequest(ctx, cred, mutation, map[string]any{
			"id": gp.NodeID, "mergeMethod": strings.ToUpper(mergeMethod),
		}, nil); err != nil {
			return domain.PullRequest{}, fmt.Errorf("github: enable auto-merge: %w", err)
		}
	} else {
		const mutation = `mutation($id: ID!) {
			disablePullRequestAutoMerge(input: {pullRequestId: $id}) {
				pullRequest { id }
			}
		}`
		if err := c.graphQLRequest(ctx, cred, mutation, map[string]any{"id": gp.NodeID}, nil); err != nil {
			return domain.PullRequest{}, fmt.Errorf("github: disable auto-merge: %w", err)
		}
	}

	gp2, err := c.getPullRequestByNumber(ctx, cred, repo, number)
	if err != nil {
		return domain.PullRequest{}, fmt.Errorf("github: refetch pull request after auto-merge change: %w", err)
	}
	return toDomainPullRequest(repo, gp2)
}

// githubIssuePatch is UpdateIssue's REST PATCH body — only fields present in
// usecase.IssuePatch are included (omitempty via pointer types matches
// GitHub's own "omit = leave unchanged" PATCH semantics).
type githubIssuePatch struct {
	Title     *string  `json:"title,omitempty"`
	Body      *string  `json:"body,omitempty"`
	State     *string  `json:"state,omitempty"`
	Assignees []string `json:"assignees,omitempty"`
}

// UpdateIssue calls GitHub's REST API: PATCH /repos/{repo}/issues/{number}
// for title/body/state/assignees, then POST/DELETE
// .../issues/{number}/labels for add/remove label deltas — GitHub has no
// single endpoint for an additive+subtractive label patch.
func (c *Client) UpdateIssue(ctx context.Context, cred usecase.Credential, repo string, number int32, patch usecase.IssuePatch) (domain.Issue, error) {
	if patch.Title != nil || patch.Body != nil || patch.State != nil || len(patch.Assignees) > 0 {
		body, err := json.Marshal(githubIssuePatch{Title: patch.Title, Body: patch.Body, State: patch.State, Assignees: patch.Assignees})
		if err != nil {
			return domain.Issue{}, fmt.Errorf("github: encode update issue body: %w", err)
		}
		reqURL := fmt.Sprintf("%s/repos/%s/issues/%d", c.baseURL, repo, number)
		req, err := http.NewRequestWithContext(ctx, http.MethodPatch, reqURL, bytes.NewReader(body))
		if err != nil {
			return domain.Issue{}, fmt.Errorf("github: build update issue request: %w", err)
		}
		req.Header.Set("Authorization", "Bearer "+cred.Token)
		req.Header.Set("Accept", "application/vnd.github+json")
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
		resp, err := c.httpClient.Do(req)
		if err != nil {
			return domain.Issue{}, fmt.Errorf("github: update issue request failed: %w", err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return domain.Issue{}, fmt.Errorf("github: update issue: unexpected status %d", resp.StatusCode)
		}
	}

	if len(patch.AddLabels) > 0 {
		body, _ := json.Marshal(struct {
			Labels []string `json:"labels"`
		}{Labels: patch.AddLabels})
		reqURL := fmt.Sprintf("%s/repos/%s/issues/%d/labels", c.baseURL, repo, number)
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, reqURL, bytes.NewReader(body))
		if err != nil {
			return domain.Issue{}, fmt.Errorf("github: build add labels request: %w", err)
		}
		req.Header.Set("Authorization", "Bearer "+cred.Token)
		req.Header.Set("Accept", "application/vnd.github+json")
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
		resp, err := c.httpClient.Do(req)
		if err != nil {
			return domain.Issue{}, fmt.Errorf("github: add labels request failed: %w", err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return domain.Issue{}, fmt.Errorf("github: add labels: unexpected status %d", resp.StatusCode)
		}
	}

	for _, label := range patch.RemoveLabels {
		reqURL := fmt.Sprintf("%s/repos/%s/issues/%d/labels/%s", c.baseURL, repo, number, url.PathEscape(label))
		req, err := http.NewRequestWithContext(ctx, http.MethodDelete, reqURL, nil)
		if err != nil {
			return domain.Issue{}, fmt.Errorf("github: build remove label request: %w", err)
		}
		req.Header.Set("Authorization", "Bearer "+cred.Token)
		req.Header.Set("Accept", "application/vnd.github+json")
		req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
		resp, err := c.httpClient.Do(req)
		if err != nil {
			return domain.Issue{}, fmt.Errorf("github: remove label request failed: %w", err)
		}
		_ = resp.Body.Close()
		// 404 means "label already absent" — not a failure for a remove op.
		if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNotFound {
			return domain.Issue{}, fmt.Errorf("github: remove label %q: unexpected status %d", label, resp.StatusCode)
		}
	}

	reqURL := fmt.Sprintf("%s/repos/%s/issues/%d", c.baseURL, repo, number)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return domain.Issue{}, fmt.Errorf("github: build get issue request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+cred.Token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return domain.Issue{}, fmt.Errorf("github: get issue request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return domain.Issue{}, fmt.Errorf("github: get issue: unexpected status %d", resp.StatusCode)
	}
	var raw githubIssue
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return domain.Issue{}, fmt.Errorf("github: decode get issue response: %w", err)
	}
	issue, err := domain.NewIssue(strconv.Itoa(raw.Number), domain.ScmProviderGitHub, repo, raw.Title, raw.State, raw.HTMLURL)
	if err != nil {
		return domain.Issue{}, fmt.Errorf("github: invalid issue in response: %w", err)
	}
	issue.Number = int32(raw.Number)
	return issue, nil
}

// GetPullRequestForBranch calls GitHub's REST API: GET /repos/{repo}/pulls
// ?head={owner}:{branch}&state=open — GitHub's head filter requires the
// "owner:branch" form even though repo already encodes owner.
func (c *Client) GetPullRequestForBranch(ctx context.Context, cred usecase.Credential, repo, headBranch string) (domain.PullRequest, bool, error) {
	owner := repo
	if idx := strings.Index(repo, "/"); idx >= 0 {
		owner = repo[:idx]
	}
	reqURL := fmt.Sprintf("%s/repos/%s/pulls?head=%s&state=open", c.baseURL, repo, url.QueryEscape(owner+":"+headBranch))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return domain.PullRequest{}, false, fmt.Errorf("github: build get pull request for branch request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+cred.Token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return domain.PullRequest{}, false, fmt.Errorf("github: get pull request for branch request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return domain.PullRequest{}, false, fmt.Errorf("github: get pull request for branch: unexpected status %d", resp.StatusCode)
	}
	var raw []githubPullRequest
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return domain.PullRequest{}, false, fmt.Errorf("github: decode get pull request for branch response: %w", err)
	}
	if len(raw) == 0 {
		return domain.PullRequest{}, false, nil
	}
	pr, err := toDomainPullRequest(repo, raw[0])
	if err != nil {
		return domain.PullRequest{}, false, fmt.Errorf("github: invalid pull request in response: %w", err)
	}
	return pr, true, nil
}

// githubRepo mirrors the fields this adapter needs from GET /repos/{owner}/{repo}
// (https://docs.github.com/en/rest/repos/repos#get-a-repository).
type githubRepo struct {
	Name  string `json:"name"`
	Owner struct {
		Login string `json:"login"`
	} `json:"owner"`
}

// ResolveRepoSlug parses candidate into an owner/name pair, then validates +
// canonicalizes it against GET /repos/{owner}/{name} — the response's own
// name/owner.login fields are the source of truth for casing (GitHub repo
// names/owners are case-insensitive on input but have one canonical case).
func (c *Client) ResolveRepoSlug(ctx context.Context, cred usecase.Credential, candidate string) (string, string, error) {
	owner, name, err := parseGitHubRepoCandidate(candidate)
	if err != nil {
		return "", "", err
	}
	reqURL := fmt.Sprintf("%s/repos/%s/%s", c.baseURL, owner, name)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return "", "", fmt.Errorf("github: build resolve repo slug request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+cred.Token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", "", fmt.Errorf("github: resolve repo slug request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return "", "", fmt.Errorf("github: resolve repo slug: unexpected status %d", resp.StatusCode)
	}
	var raw githubRepo
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return "", "", fmt.Errorf("github: decode resolve repo slug response: %w", err)
	}
	return raw.Owner.Login, raw.Name, nil
}

// parseGitHubRepoCandidate extracts owner/name from a git remote URL
// (https or ssh form) or a bare "owner/name" string.
func parseGitHubRepoCandidate(candidate string) (owner, name string, err error) {
	c := strings.TrimSuffix(strings.TrimSpace(candidate), ".git")
	switch {
	case strings.HasPrefix(c, "git@github.com:"):
		c = strings.TrimPrefix(c, "git@github.com:")
	case strings.Contains(c, "github.com/"):
		parts := strings.SplitN(c, "github.com/", 2)
		c = parts[len(parts)-1]
	}
	c = strings.Trim(c, "/")
	parts := strings.Split(c, "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", "", fmt.Errorf("github: cannot resolve %q to an owner/name pair", candidate)
	}
	return parts[0], parts[1], nil
}

// BranchExists calls GitHub's REST API: GET /repos/{repo}/branches/{branch}
// — 200 means it exists, 404 means it doesn't (not an error in either case).
func (c *Client) BranchExists(ctx context.Context, cred usecase.Credential, repo, branch string) (bool, error) {
	reqURL := fmt.Sprintf("%s/repos/%s/branches/%s", c.baseURL, repo, url.PathEscape(branch))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return false, fmt.Errorf("github: build branch exists request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+cred.Token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return false, fmt.Errorf("github: branch exists request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	switch resp.StatusCode {
	case http.StatusOK:
		return true, nil
	case http.StatusNotFound:
		return false, nil
	default:
		return false, fmt.Errorf("github: branch exists: unexpected status %d", resp.StatusCode)
	}
}

// githubUpdatePullRequestBody is the PATCH request body —
// https://docs.github.com/en/rest/pulls/pulls#update-a-pull-request.
// Only Title is set today, matching PullRequestPatch's current scope.
type githubUpdatePullRequestBody struct {
	Title *string `json:"title,omitempty"`
}

// UpdatePullRequest PATCHes repo's pull request number with patch's
// non-nil fields.
func (c *Client) UpdatePullRequest(ctx context.Context, cred usecase.Credential, repo string, number int32, patch usecase.PullRequestPatch) (domain.PullRequest, error) {
	body, err := json.Marshal(githubUpdatePullRequestBody{Title: patch.Title})
	if err != nil {
		return domain.PullRequest{}, fmt.Errorf("github: encode update pull request body: %w", err)
	}
	reqURL := fmt.Sprintf("%s/repos/%s/pulls/%d", c.baseURL, repo, number)
	req, err := http.NewRequestWithContext(ctx, http.MethodPatch, reqURL, bytes.NewReader(body))
	if err != nil {
		return domain.PullRequest{}, fmt.Errorf("github: build update pull request request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+cred.Token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return domain.PullRequest{}, fmt.Errorf("github: update pull request request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return domain.PullRequest{}, fmt.Errorf("github: update pull request: unexpected status %d", resp.StatusCode)
	}
	var raw githubPullRequest
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return domain.PullRequest{}, fmt.Errorf("github: decode update pull request response: %w", err)
	}
	pr, err := toDomainPullRequest(repo, raw)
	if err != nil {
		return domain.PullRequest{}, fmt.Errorf("github: invalid pull request in update response: %w", err)
	}
	return pr, nil
}

// StarRepository stars repo (an "owner/name" slug) on behalf of cred's
// connected GitHub account, via PUT /user/starred/{owner}/{repo}
// (https://docs.github.com/en/rest/activity/starring#star-a-repository-for-the-authenticated-user).
// Idempotent on GitHub's side (starring an already-starred repo still
// 204s) — this method has no separate "already starred" branch.
func (c *Client) StarRepository(ctx context.Context, cred usecase.Credential, repo string) (bool, error) {
	reqURL := fmt.Sprintf("%s/user/starred/%s", c.baseURL, repo)
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, reqURL, nil)
	if err != nil {
		return false, fmt.Errorf("github: build star repository request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+cred.Token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.ContentLength = 0

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return false, fmt.Errorf("github: star repository request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusNoContent {
		return false, fmt.Errorf("github: star repository: unexpected status %d", resp.StatusCode)
	}
	return true, nil
}
