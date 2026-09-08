# TASK-036: `UpdatePullRequest` usecase, GitHub adapter implementation, and `github.updatePRTitle` wscompat channel

**From Solution:** SOL-012
**Priority:** P0 — real capability behind `github.updatePRTitle`; independent of TASK-035 (different RPC, different usecase), both depend only on TASK-034
**Service:** `scm-integration-service` (usecase + adapter + gRPC wiring) / `api-gateway` (wscompat channel)
**File:** `backend-go/services/scm-integration-service/internal/usecase/ports.go`, `internal/usecase/update_pull_request.go` (new), `internal/usecase/update_pull_request_test.go` (new), `internal/usecase/scm_provider_dispatch_test.go`, `internal/adapter/github/client.go`, `internal/adapter/gitlab/client.go`, `internal/adapter/bitbucket/client.go`, `internal/adapter/azuredevops/client.go`, `internal/adapter/gitea/client.go`, `internal/adapter/grpc/server.go`, `cmd/server/main.go`, `backend-go/services/api-gateway/internal/adapter/wscompat/channels_scm.go`
**Depends on:** TASK-034 (needs the generated `UpdatePullRequestRequest`/`ScmIntegrationServiceClient.UpdatePullRequest` types)
**Status:** `[x]` DONE — as specified. Implemented the `ScmProvider.UpdatePullRequest` port + `PullRequestPatch` type, the real GitHub adapter method (PATCH /repos/{owner}/{repo}/pulls/{number}), `ErrCapabilityUnsupported` stubs in the other 4 adapters, the `UpdatePullRequest` usecase (+ `fakeProviderCapturingPatch` test double), gRPC server handler + `cmd/server/main.go` wiring, and the `github.updatePRTitle` wscompat channel. Deviation: added a `getRemoteUrlFunc`/`GetRemoteUrl` override to the shared `fakeGitGatewayClient` test double (channels_git_test.go) — it didn't exist yet and `resolveGitHubOwnerRepo` (reused, unchanged) needs it to be testable; wrote 3 channel tests (resolves-and-updates, unresolvable-repo-errors, RPC-error-propagates) covering the task's described assertions rather than the literal snippet (which described behavior, not full test bodies). Also fixed a copy-paste type-name slip in my own first draft (`gitgatewayv1.RemoteUrlResponse` vs. the real `GetRemoteUrlResponse`) caught by `go vet`. All builds/vet/tests pass (`go test ./services/scm-integration-service/... ./services/api-gateway/...`); no dedicated adapter-level HTTP test for `UpdatePullRequest` itself (task sketch only specified usecase-layer tests for it).

---

## Context

BUG-012 found `github.updatePRTitle` unregistered, with the closest existing RPC
(`UpdatePullRequestBySlug`) addressing a fundamentally different GitHub API surface
(a Projects v2 board item by slug, returning `WorkItemDetails`) rather than a plain
`(repo, number)` PR. SOL-012 designs `UpdatePullRequest` to mirror `UpdateIssue`'s real
shape exactly — same `(tenant_id, provider, repo, number)` address, same `optional`
partial-update field pattern, same "narrow RPC on the underlying REST resource" style
`MergePullRequest`/`SetPullRequestAutoMerge` already use. This task follows the same
real `ScmProvider`-interface-method + per-adapter-stub convention TASK-035 uses for
`StarRepository` (confirmed against the real current `ports.go`/adapter files, not
SOL-012's own sketch, which invented a separate `githubapi` package + a
`usecase.Identity` parameter neither of which exist in this codebase's real structure
— the real adapter package is `internal/adapter/github`, and `UpdateIssue`'s real
`Execute` takes no identity parameter at all, confirmed at `usecase/update_issue.go`).

## Changes to make

### Step 1 — `ports.go`: add `UpdatePullRequest` to the `ScmProvider` interface

Add alongside `UpdateIssue` in the same interface block (`ports.go:58-67`, verbatim
quoted in TASK-035's Step 1 — if TASK-035 lands first, `StarRepository` will already be
in this block; add `UpdatePullRequest` alongside it, not replacing it):

```go
	// UpdatePullRequest — github.updatePRTitle (SOL-012). Plain (repo,
	// number) address + a PullRequestPatch mirroring IssuePatch's
	// nil-means-unchanged convention. GitHub implements it for real
	// against PATCH /repos/{owner}/{repo}/pulls/{number}; every other
	// adapter returns its own ErrCapabilityUnsupported, same convention as
	// this block's other methods.
	UpdatePullRequest(ctx context.Context, cred Credential, repo string, number int32, patch PullRequestPatch) (domain.PullRequest, error)
```

Add the `PullRequestPatch` type next to `IssuePatch` (`ports.go:91-100`, same file):

```go
// PullRequestPatch is UpdatePullRequest's partial-update shape — nil
// pointer fields mean "leave unchanged", same convention as IssuePatch.
// Title-only today (github.updatePRTitle's actual wire shape); additive
// fields (Body, Base, State) can be added later without a breaking change,
// mirroring how IssuePatch itself grew incrementally.
type PullRequestPatch struct {
	Title *string
}
```

### Step 2 — `internal/adapter/github/client.go`: real implementation

Follow `UpdateIssue`'s real request-building idiom in this same file (its PATCH
request construction, same headers as `GetPullRequestForBranch`'s GET). Reuse the
existing `toDomainPullRequest`/`githubPullRequest` decode helpers already used by
`GetPullRequestForBranch` (`client.go:653,660`) for the response body — GitHub's PATCH
pull-request endpoint returns the full updated PR object, same shape as the list
endpoint's items:

```go
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
```

Confirm `bytes` is already imported in this file (used elsewhere for other PATCH/POST
bodies — check before adding a duplicate import) and that `githubPullRequest`/
`toDomainPullRequest`'s real signatures match this usage exactly (read them directly
from `client.go` before finalizing this method — they're referenced here from
`GetPullRequestForBranch`'s real usage at `client.go:653,660` but not independently
re-verified in this task's own research pass).

### Step 3 — stub the other 4 adapters

Same mechanical addition as TASK-035 Step 3, in each of `gitlab`, `bitbucket`,
`azuredevops`, `gitea`'s `client.go`, using each file's own existing
`ErrCapabilityUnsupported` sentinel:

```go
func (c *Client) UpdatePullRequest(_ context.Context, _ usecase.Credential, _ string, _ int32, _ usecase.PullRequestPatch) (domain.PullRequest, error) {
	return domain.PullRequest{}, ErrCapabilityUnsupported
}
```

**If TASK-035 lands in the same working session**, both tasks add a stub method to
these same 4 files — add each independently; check the file's current state before
editing if picking this task up second.

### Step 4 — `internal/usecase/update_pull_request.go` (new)

Mirrors `UpdateIssue`'s real shape exactly:

```go
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
```

### Step 5 — extend the shared `fakeProvider` (`scm_provider_dispatch_test.go`)

Add fields:

```go
	updatedPR       domain.PullRequest
	updatePRErr     error
```

And a method (same style as `UpdateIssue`'s fake at line 106-112):

```go
func (f *fakeProvider) UpdatePullRequest(ctx context.Context, cred Credential, repo string, number int32, patch PullRequestPatch) (domain.PullRequest, error) {
	f.lastCred, f.lastRepo = cred, repo
	f.calls++
	if f.updatePRErr != nil {
		return domain.PullRequest{}, f.updatePRErr
	}
	return f.updatedPR, nil
}
```

(Same shared-file caution as TASK-035 Step 5: check the file's current state before
editing if TASK-035 already landed.)

### Step 6 — `internal/usecase/update_pull_request_test.go` (new)

Mirrors `update_issue_test.go`'s exact structure:

```go
package usecase

import (
	"context"
	"errors"
	"testing"

	"github.com/stablyai/orca-go/services/scm-integration-service/internal/domain"
)

func TestUpdatePullRequest_Success(t *testing.T) {
	pr := domain.PullRequest{ID: "1", Provider: domain.ScmProviderGitHub, Repo: "o/r", Title: "new title", Number: 5}
	provider := &fakeProvider{updatedPR: pr}
	registry := &fakeRegistry{providers: map[domain.ScmProvider]ScmProvider{domain.ScmProviderGitHub: provider}}
	uc := NewUpdatePullRequest(&fakeCredentialResolver{token: "tok"}, registry)

	title := "new title"
	got, err := uc.Execute(context.Background(), UpdatePullRequestParams{
		TenantID: "tenant-1", Provider: domain.ScmProviderGitHub, Repo: "o/r", Number: 5, Patch: PullRequestPatch{Title: &title},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Title != "new title" || provider.calls != 1 {
		t.Fatalf("unexpected result: %+v calls=%d", got, provider.calls)
	}
}

func TestUpdatePullRequest_NilTitleMeansUnchanged(t *testing.T) {
	var capturedPatch PullRequestPatch
	provider := &fakeProviderCapturingPatch{&capturedPatch}
	registry := &fakeRegistry{providers: map[domain.ScmProvider]ScmProvider{domain.ScmProviderGitHub: provider}}
	uc := NewUpdatePullRequest(&fakeCredentialResolver{token: "tok"}, registry)

	if _, err := uc.Execute(context.Background(), UpdatePullRequestParams{TenantID: "tenant-1", Provider: domain.ScmProviderGitHub, Repo: "o/r", Number: 1}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if capturedPatch.Title != nil {
		t.Errorf("want a nil Title passed straight through as 'no title field sent', got %v", capturedPatch.Title)
	}
}

func TestUpdatePullRequest_PropagatesProviderFailure(t *testing.T) {
	provider := &fakeProvider{updatePRErr: errors.New("not found")}
	registry := &fakeRegistry{providers: map[domain.ScmProvider]ScmProvider{domain.ScmProviderGitHub: provider}}
	uc := NewUpdatePullRequest(&fakeCredentialResolver{token: "tok"}, registry)

	_, err := uc.Execute(context.Background(), UpdatePullRequestParams{TenantID: "tenant-1", Provider: domain.ScmProviderGitHub, Repo: "o/r", Number: 1})
	if err == nil {
		t.Fatal("expected an error when the provider call fails")
	}
}

func TestUpdatePullRequest_RequiresTenantAndRepo(t *testing.T) {
	uc := NewUpdatePullRequest(&fakeCredentialResolver{}, &fakeRegistry{providers: map[domain.ScmProvider]ScmProvider{}})
	cases := []UpdatePullRequestParams{{Repo: "o/r"}, {TenantID: "t1"}}
	for _, in := range cases {
		if _, err := uc.Execute(context.Background(), in); err == nil {
			t.Errorf("expected a validation error for %+v", in)
		}
	}
}
```

`fakeProviderCapturingPatch` is a small one-off fake local to this test file (embeds
`ScmProvider` as nil the same way other fakes in this package do, overrides only
`UpdatePullRequest` to record its `patch` argument into the pointer it's given) — write
it directly in `update_pull_request_test.go` rather than extending the shared
`fakeProvider` further, since capturing an argument (not just returning a canned
value) doesn't fit that struct's existing "set a result field, read it back" shape.

### Step 7 — `internal/adapter/grpc/server.go`: RPC handler

Same pattern as TASK-035 Step 7 — add `updatePullRequest *usecase.UpdatePullRequest`
field + constructor parameter, and:

```go
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
```

`toProtoPullRequest` already exists (used by `GetPullRequestForBranch`'s handler,
`server.go:376`) — reuse it, don't redeclare it.

### Step 8 — `cmd/server/main.go`: composition root wiring

Add alongside `updateIssueUC` (`main.go:167`):

```go
	updatePullRequestUC := usecase.NewUpdatePullRequest(credentials, registry)
```

Add `updatePullRequestUC` to the `scmgrpc.New(...)` call's argument list and
`grpc.New`'s signature, same insertion point as TASK-035's `starRepositoryUC`.

### Step 9 — `api-gateway`'s `channels_scm.go`: real `github.updatePRTitle` channel

Add to `registerGitHubChannels`, reusing the existing `resolveGitHubOwnerRepo` helper
(real current signature, verbatim: `func resolveGitHubOwnerRepo(ctx context.Context,
gitClient gitgatewayv1.GitGatewayServiceClient, repoID string) (githubOwnerRepo, bool,
error)` — note it takes `gitClient` and `repoID` only, NOT an `id Identity` parameter,
unlike SOL-012's own sketch which incorrectly passed one):

```go
	// github.updatePRTitle
	r.Register("github.updatePRTitle", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type updateTitleArgs struct {
			Repo   string `json:"repo"` // "id:<repoId>" | "<repoPath>" — same shape github.listWorkItems resolves
			Number int32  `json:"prNumber"`
			Title  string `json:"title"`
		}
		in, err := decodeArg[updateTitleArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ownerRepo, _, resolveErr := resolveGitHubOwnerRepo(ctx, gitClient, in.Repo)
		if resolveErr != nil {
			return nil, resolveErr
		}
		rpcCtx, cancel := context.WithTimeout(ctx, scmRPCTimeout)
		defer cancel()
		title := in.Title
		_, err = client.UpdatePullRequest(attachSCMIdentity(rpcCtx, id), &scmintegrationv1.UpdatePullRequestRequest{
			TenantId: id.TenantID, Provider: scmintegrationv1.ScmProvider_SCM_PROVIDER_GITHUB,
			Repo: ownerRepo.slug(), Number: in.Number, Title: &title,
		})
		if err != nil {
			return nil, err
		}
		return true, nil // github.updatePRTitle's frontend contract is Promise<boolean>
		                  // (frontend/src/preload/api-types.ts:1605-1610); the RPC's real
		                  // PullRequest response is discarded in favor of a plain success bool.
	})
```

`registerGitHubChannels`'s real current signature already takes `gitClient
gitgatewayv1.GitGatewayServiceClient` as a parameter (`channels_scm.go:58`, used
already by `github.listWorkItems`) — no signature change needed.

`channels_scm_test.go` already exists with a `fakeScmIntegrationClient` (embeds the
nil `scmintegrationv1.ScmIntegrationServiceClient` interface, one `xFunc` field +
override method per RPC it exercises, e.g. `updateIssueFunc`/`UpdateIssue` at
`channels_scm_test.go:23,67-69`) — add an `updatePullRequestFunc` field and matching
override method in that same style:

```go
func (f *fakeScmIntegrationClient) UpdatePullRequest(ctx context.Context, in *scmintegrationv1.UpdatePullRequestRequest, _ ...grpc.CallOption) (*scmintegrationv1.PullRequest, error) {
	return f.updatePullRequestFunc(ctx, in)
}
```

Add a test asserting: both `repo: "id:..."` and `repo: "<owner>/<name>"` input shapes
resolve correctly, the channel returns `true` on RPC success regardless of the RPC's
actual `PullRequest` body content, and an RPC error propagates as a channel error (not
silently swallowed into `false`).

## Verify

```bash
cd backend-go
go build ./services/scm-integration-service/... ./services/api-gateway/...
go vet ./services/scm-integration-service/... ./services/api-gateway/...
go test ./services/scm-integration-service/internal/usecase/... -run TestUpdatePullRequest -v -count=1
go test ./services/scm-integration-service/internal/adapter/github/... -run TestUpdatePullRequest -v -count=1
go test ./services/api-gateway/internal/adapter/wscompat/... -run TestGithubUpdatePRTitle -v -count=1
go test ./services/scm-integration-service/... ./services/api-gateway/...
```
