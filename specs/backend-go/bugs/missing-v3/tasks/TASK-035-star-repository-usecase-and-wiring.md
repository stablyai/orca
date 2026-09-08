# TASK-035: `StarRepository` usecase, GitHub adapter implementation, and `github.starOrca` wscompat channel

**From Solution:** SOL-012
**Priority:** P0 — real capability behind `github.starOrca`; **note for cross-agent visibility: SOL-005's `starNag.starOrca` (a different agent's task range, TASK-009–TASK-018) has a task waiting on this one landing** — SOL-005 ships `starNag.starOrca` with a stub port now and a separate follow-up task to wire it to this RPC once it exists, so this task is a real dependency for that other task set even though it isn't numbered in this range
**Service:** `scm-integration-service` (usecase + adapter + gRPC wiring) / `api-gateway` (wscompat channel)
**File:** `backend-go/services/scm-integration-service/internal/usecase/ports.go`, `internal/usecase/star_repository.go` (new), `internal/usecase/star_repository_test.go` (new), `internal/usecase/scm_provider_dispatch_test.go`, `internal/adapter/github/client.go`, `internal/adapter/gitlab/client.go`, `internal/adapter/bitbucket/client.go`, `internal/adapter/azuredevops/client.go`, `internal/adapter/gitea/client.go`, `internal/adapter/grpc/server.go`, `cmd/server/main.go`, `backend-go/services/api-gateway/internal/adapter/wscompat/channels_scm.go`
**Depends on:** TASK-034 (needs the generated `StarRepositoryRequest`/`StarRepositoryResponse`/`ScmIntegrationServiceClient.StarRepository` types)
**Status:** `[x]` DONE — as specified. Implemented the `ScmProvider.StarRepository` port, the real GitHub adapter method (PUT /user/starred/{owner}/{repo}), `ErrCapabilityUnsupported` stubs in gitlab/bitbucket/azuredevops/gitea, the `StarRepository` usecase, gRPC server handler + `cmd/server/main.go` composition-root wiring, and the `github.starOrca` wscompat channel with tests. Deviation: the task's own Step 9 test snippet for `channels_scm_test.go` wasn't copy-pasted verbatim (it described assertions rather than full test bodies) — wrote 3 equivalent tests (`TestGitHubStarOrcaChannel_AlwaysStarsTheOrcaRepoRegardlessOfSource`/`_MissingSourceDoesNotFail`/`_RPCErrorPropagates`) covering the same 3 behaviors. All builds/vet/tests pass (`go test ./services/scm-integration-service/... ./services/api-gateway/...`); no dedicated `internal/adapter/github` test was added for `StarRepository` itself (the task's own sketch didn't include one, only usecase-layer tests), so `go test .../adapter/github/... -run TestStarRepository` finds no matching tests (not a failure, just nothing to run) — a real HTTP-level adapter test would be a good low-cost follow-up.

---

## Context

BUG-012 found `github.starOrca` unregistered with no backing RPC at all. SOL-012
resolves the open routing question ("per-tenant OAuth, or a lighter fixed-app-token
fire-and-forget?") in favor of the per-tenant OAuth path — GitHub's star endpoint (`PUT
/user/starred/{owner}/{repo}`) stars the repo on behalf of whichever identity
authenticated the call, so a fixed service token would star as some other GitHub
account entirely, not capture "this connected account starred Orca" the way the
feature's `source` parameter implies. This follows the exact same
`ScmProvider`-interface-method + per-adapter-stub pattern the existing SOL-012
GitHub-mutation methods (`MergePullRequest`, `UpdateIssue`, etc.) already established —
confirmed against the real current `ports.go`/adapter files below, not SOL-012's own
sketch (which used a narrower bespoke port + a `usecase.Identity` parameter that
doesn't match this codebase's real `CredentialResolver.Resolve(ctx, tenantID,
provider)` signature — there is no per-user credential resolution here today, only
per-`(tenant, provider)`, confirmed at `ports.go:151-153`).

## Changes to make

### Step 1 — `ports.go`: add `StarRepository` to the `ScmProvider` interface

Real current interface block (verbatim, `ports.go:58-67`):

```go
	// MergePullRequest / RequestPullRequestReviewers / RemovePullRequestReviewers
	// / SetPullRequestAutoMerge / UpdateIssue — see SOL-012 shape 1. GitHub
	// implements all five for real (TASK-075); other adapters return their
	// own package-level ErrCapabilityUnsupported sentinel until wired,
	// mirroring the azuredevops/gitea precedent already in this codebase.
	MergePullRequest(ctx context.Context, cred Credential, repo string, number int32, input MergePullRequestInput) (domain.PullRequest, bool, string, error)
	RequestPullRequestReviewers(ctx context.Context, cred Credential, repo string, number int32, reviewerLogins, teamSlugs []string) (domain.PullRequest, error)
	RemovePullRequestReviewers(ctx context.Context, cred Credential, repo string, number int32, reviewerLogins []string) (domain.PullRequest, error)
	SetPullRequestAutoMerge(ctx context.Context, cred Credential, repo string, number int32, enabled bool, mergeMethod string) (domain.PullRequest, error)
	UpdateIssue(ctx context.Context, cred Credential, repo string, number int32, patch IssuePatch) (domain.Issue, error)
```

Add immediately after `UpdateIssue`'s line:

```go
	// StarRepository — github.starOrca (SOL-012). GitHub implements it for
	// real against PUT /user/starred/{owner}/{repo}; every other adapter
	// returns its own ErrCapabilityUnsupported, same convention as the
	// block above.
	StarRepository(ctx context.Context, cred Credential, repo string) (bool, error)
```

(If TASK-036 lands first, `UpdatePullRequest` will already be present in this same
block — add `StarRepository` alongside it rather than reordering either.)

### Step 2 — `internal/adapter/github/client.go`: real implementation

Follow `GetPullRequestForBranch`'s exact request-building idiom (verbatim reference,
`client.go:631-649`: build `req` with `http.NewRequestWithContext`, set
`Authorization: Bearer <cred.Token>`, `Accept: application/vnd.github+json`,
`X-GitHub-Api-Version: 2022-11-28`, check `resp.StatusCode`). GitHub's star endpoint
returns `204 No Content` on success, `304 Not Modified` never applies to `PUT` (only
the check-if-starred `GET`), so only `204` is success:

```go
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
```

Place it near `GetPullRequestForBranch`/`ResolveRepoSlug` (same file, same
SOL-012-mutation-methods section).

### Step 3 — stub the other 4 adapters

Each of `gitlab`, `bitbucket`, `azuredevops`, `gitea`'s `client.go` already has a block
of one-line `ErrCapabilityUnsupported` stubs for this exact method family (verbatim
current example, `gitlab/client.go:301-303`):

```go
func (c *Client) ResolveRepoSlug(_ context.Context, _ usecase.Credential, _ string) (string, string, error) {
	return "", "", ErrCapabilityUnsupported
}
```

Add one more stub to each of the 4 files' equivalent block, using each file's own
already-declared `ErrCapabilityUnsupported` sentinel (`gitlab/client.go:43`,
`bitbucket/client.go:38`, `azuredevops/client.go:41`, `gitea/client.go:43` — all
already exist, confirmed):

```go
func (c *Client) StarRepository(_ context.Context, _ usecase.Credential, _ string) (bool, error) {
	return false, ErrCapabilityUnsupported
}
```

### Step 4 — `internal/usecase/star_repository.go` (new)

Mirrors `UpdateIssue`'s real current shape (`usecase/update_issue.go`, verbatim above)
exactly — `Params` struct name, `CredentialResolver`+`ProviderRegistry` dependencies,
`apperrors.New` error wrapping, no `usecase.Identity`/per-user parameter (this
service's `CredentialResolver` resolves per `(tenantID, provider)`, not per user —
confirmed `ports.go:151-153`):

```go
package usecase

import (
	"context"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/services/scm-integration-service/internal/domain"
)

type StarRepositoryParams struct {
	TenantID string
	Provider domain.ScmProvider
	Repo     string
}

type StarRepository struct {
	credentials CredentialResolver
	providers   ProviderRegistry
}

func NewStarRepository(credentials CredentialResolver, providers ProviderRegistry) *StarRepository {
	return &StarRepository{credentials: credentials, providers: providers}
}

func (uc *StarRepository) Execute(ctx context.Context, in StarRepositoryParams) (bool, error) {
	if in.TenantID == "" {
		return false, apperrors.New(apperrors.KindInvalidArgument, "SCM_NO_TENANT", "tenant_id is required", nil)
	}
	if in.Repo == "" {
		return false, apperrors.New(apperrors.KindInvalidArgument, "SCM_EMPTY_REPO", "repo is required", nil)
	}
	cred, err := uc.credentials.Resolve(ctx, in.TenantID, in.Provider)
	if err != nil {
		return false, apperrors.New(apperrors.KindInternal, "SCM_CREDENTIAL_RESOLVE_FAILED", "failed to resolve provider credential", err)
	}
	provider, err := uc.providers.Resolve(in.Provider)
	if err != nil {
		return false, apperrors.New(apperrors.KindInvalidArgument, "SCM_PROVIDER_UNSUPPORTED", "no adapter registered for this provider", err)
	}
	starred, err := provider.StarRepository(ctx, cred, in.Repo)
	if err != nil {
		return false, apperrors.New(apperrors.KindInternal, "SCM_STAR_REPOSITORY_FAILED", "failed to star repository", err)
	}
	return starred, nil
}
```

### Step 5 — `internal/usecase/scm_provider_dispatch_test.go`: extend the shared `fakeProvider`

This file's `fakeProvider` (verbatim current struct, lines 18-57) already implements
the whole `ScmProvider` interface for every usecase's tests — adding a new interface
method means this fake must grow a matching method too, or every existing test in this
package fails to compile. Add fields:

```go
	starRepositoryResult bool
	starRepositoryErr    error
```

And a method (same style as `ResolveRepoSlug`'s at line 124-131):

```go
func (f *fakeProvider) StarRepository(ctx context.Context, cred Credential, repo string) (bool, error) {
	f.lastCred, f.lastRepo = cred, repo
	f.calls++
	if f.starRepositoryErr != nil {
		return false, f.starRepositoryErr
	}
	return f.starRepositoryResult, nil
}
```

**If TASK-036 lands in the same working session**, both tasks touch this file — add
each method independently rather than one task overwriting the other's addition; check
the file's current state before editing if picking this task up second.

### Step 6 — `internal/usecase/star_repository_test.go` (new)

Mirrors `update_issue_test.go`'s exact structure (verbatim reference above):

```go
package usecase

import (
	"context"
	"errors"
	"testing"

	"github.com/stablyai/orca-go/services/scm-integration-service/internal/domain"
)

func TestStarRepository_Success(t *testing.T) {
	provider := &fakeProvider{starRepositoryResult: true}
	registry := &fakeRegistry{providers: map[domain.ScmProvider]ScmProvider{domain.ScmProviderGitHub: provider}}
	uc := NewStarRepository(&fakeCredentialResolver{token: "tok"}, registry)

	starred, err := uc.Execute(context.Background(), StarRepositoryParams{TenantID: "tenant-1", Provider: domain.ScmProviderGitHub, Repo: "getorca/orca"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !starred {
		t.Error("want starred=true")
	}
	if provider.lastRepo != "getorca/orca" {
		t.Errorf("want repo passed through unmodified, got %q", provider.lastRepo)
	}
	if provider.calls != 1 {
		t.Errorf("want exactly 1 provider call, got %d", provider.calls)
	}
}

func TestStarRepository_UsesCallersOwnCredential(t *testing.T) {
	cred := Credential{Token: "caller-token"}
	provider := &fakeProvider{starRepositoryResult: true}
	registry := &fakeRegistry{providers: map[domain.ScmProvider]ScmProvider{domain.ScmProviderGitHub: provider}}
	uc := NewStarRepository(&fakeCredentialResolver{token: cred.Token}, registry)

	if _, err := uc.Execute(context.Background(), StarRepositoryParams{TenantID: "tenant-1", Provider: domain.ScmProviderGitHub, Repo: "o/r"}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if provider.lastCred.Token != cred.Token {
		t.Errorf("want the resolved (tenant, provider) credential passed through, got %+v", provider.lastCred)
	}
}

func TestStarRepository_CredentialResolutionFailurePropagates(t *testing.T) {
	registry := &fakeRegistry{providers: map[domain.ScmProvider]ScmProvider{domain.ScmProviderGitHub: &fakeProvider{}}}
	uc := NewStarRepository(&fakeCredentialResolver{err: errors.New("no GitHub connection")}, registry)

	_, err := uc.Execute(context.Background(), StarRepositoryParams{TenantID: "tenant-1", Provider: domain.ScmProviderGitHub, Repo: "o/r"})
	if err == nil {
		t.Fatal("want an error when no OAuth credential is connected — must not silently no-op")
	}
}

func TestStarRepository_RequiresTenantAndRepo(t *testing.T) {
	uc := NewStarRepository(&fakeCredentialResolver{}, &fakeRegistry{providers: map[domain.ScmProvider]ScmProvider{}})
	cases := []StarRepositoryParams{{Repo: "o/r"}, {TenantID: "t1"}}
	for _, in := range cases {
		if _, err := uc.Execute(context.Background(), in); err == nil {
			t.Errorf("expected a validation error for %+v", in)
		}
	}
}
```

Check `fakeCredentialResolver`'s real field name for injecting a resolution error
(likely `err` — verify against its definition in `scm_provider_dispatch_test.go` or a
sibling test-helper file before assuming).

### Step 7 — `internal/adapter/grpc/server.go`: RPC handler

Add a `starRepository *usecase.StarRepository` field to `Server` (alongside
`updateIssue` at line 41) and a matching `New(...)` constructor parameter (alongside
`updateIssue *usecase.UpdateIssue` at line 89) — thread it through the same way every
other field in this constructor already is. Add the handler, mirroring `UpdateIssue`'s
real current shape (verbatim reference, `server.go:343-365`):

```go
func (s *Server) StarRepository(ctx context.Context, req *scmintegrationv1.StarRepositoryRequest) (*scmintegrationv1.StarRepositoryResponse, error) {
	starred, err := s.starRepository.Execute(ctx, usecase.StarRepositoryParams{
		TenantID: req.GetTenantId(), Provider: toDomainProvider(req.GetProvider()), Repo: req.GetRepo(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &scmintegrationv1.StarRepositoryResponse{Starred: starred}, nil
}
```

### Step 8 — `cmd/server/main.go`: composition root wiring

Add, alongside the real current `updateIssueUC := usecase.NewUpdateIssue(credentials,
registry)` line (`main.go:167`):

```go
	starRepositoryUC := usecase.NewStarRepository(credentials, registry)
```

Add `starRepositoryUC` to the `scmgrpc.New(...)` call's real current argument list
(`main.go:203-216`) — append it in the same grouping as `updateIssueUC` (that call's
first mutation-group line, `main.go:206-207`), and add the matching parameter to
`grpc.New`'s signature from Step 7.

### Step 9 — `api-gateway`'s `channels_scm.go`: real `github.starOrca` channel

Real current stub (verbatim, `channels_scm.go:59-70`):

```go
	// github.checkOrcaStarred — the old TS backend shelled out to the local
	// `gh` CLI ... null ("unable to determine") is not a stub here ...
	r.Register("github.checkOrcaStarred", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		return nil, nil
	})
```

`github.starOrca` itself is currently unregistered (falls through to
`notImplementedHandler`). Add, in the same `registerGitHubChannels` function:

```go
	// orcaRepoSlug is the one repo github.starOrca ever stars — not
	// user-supplied (the frontend call site sends only {source}, a UI-location
	// tag, per runtime-github-client.ts:79-88).
	const orcaRepoSlug = "getorca/orca" // confirm the real org/repo slug against the actual GitHub remote before shipping

	// github.starOrca — the write-side twin of github.checkOrcaStarred's
	// honest nil,nil no-op above: now has a real backing RPC (SOL-012/TASK-034),
	// so it is wired for real rather than staying a stub.
	r.Register("github.starOrca", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type starArgs struct {
			Source string `json:"source"`
		}
		// source (runtime-github-client.ts:79-88's caller-supplied UI-location
		// tag, e.g. "landing-page") is accepted for wire-shape compatibility but
		// not forwarded to scm-integration-service — GitHub's star API has no
		// concept of "why," and this service does not log/analytics-track
		// per-call metadata. If starOrca's source ever needs recording for
		// product analytics, that belongs in a telemetry event emitted here in
		// api-gateway, not as a new scm-integration-service RPC field.
		_, _ = decodeArg[starArgs](args, 0)

		rpcCtx, cancel := context.WithTimeout(ctx, scmRPCTimeout)
		defer cancel()
		resp, err := client.StarRepository(attachSCMIdentity(rpcCtx, id), &scmintegrationv1.StarRepositoryRequest{
			TenantId: id.TenantID, Provider: scmintegrationv1.ScmProvider_SCM_PROVIDER_GITHUB, Repo: orcaRepoSlug,
		})
		if err != nil {
			return nil, err
		}
		return resp.GetStarred(), nil
	})
```

`channels_scm_test.go` already exists with a `fakeScmIntegrationClient` (embeds the
nil `scmintegrationv1.ScmIntegrationServiceClient` interface, one `xFunc` field +
override method per RPC it exercises, e.g. `updateIssueFunc`/`UpdateIssue` at
`channels_scm_test.go:23,67-69`) — add a `starRepositoryFunc` field and matching
`StarRepository` override method in that same style, then a test:

```go
func (f *fakeScmIntegrationClient) StarRepository(ctx context.Context, in *scmintegrationv1.StarRepositoryRequest, _ ...grpc.CallOption) (*scmintegrationv1.StarRepositoryResponse, error) {
	return f.starRepositoryFunc(ctx, in)
}
```

Asserting: the relayed `Repo` is always `orcaRepoSlug` regardless of `source`'s value,
a missing/empty `source` arg does not fail the call, and an RPC error propagates as a
channel error.

## Verify

```bash
cd backend-go
go build ./services/scm-integration-service/... ./services/api-gateway/...
go vet ./services/scm-integration-service/... ./services/api-gateway/...
go test ./services/scm-integration-service/internal/usecase/... -run TestStarRepository -v -count=1
go test ./services/scm-integration-service/internal/adapter/github/... -run TestStarRepository -v -count=1
go test ./services/api-gateway/internal/adapter/wscompat/... -run TestGithubStarOrca -v -count=1
go test ./services/scm-integration-service/... ./services/api-gateway/...
```

The last line is a full-package pass for both services — required here specifically
because Step 1's interface change potentially breaks every existing `ScmProvider`
implementer/fake that doesn't yet have a `StarRepository` method (Step 3/Step 5 are
meant to close all of them, but a full test run is the real proof).
