# SOL-012: `StarRepository` rides the same per-tenant OAuth client as every other `github.*` RPC (no fixed-token shortcut); `UpdatePullRequest` mirrors `UpdateIssueRequest`'s plain-address shape

**Resolves:** [BUG-012](../BUG-012-github-starorca-updateprtitle-not-implemented.md)
**Service:** `scm-integration-service` (2 new RPCs + usecase work) / `api-gateway` (2 new `wscompat` channels)
**Affected files (proposed):**
- `backend-go/proto/orca/scmintegration/v1/scmintegration.proto` (2 new RPCs: `StarRepository`, `UpdatePullRequest`)
- `backend-go/services/scm-integration-service/internal/usecase/star_repository.go` (new)
- `backend-go/services/scm-integration-service/internal/usecase/update_pull_request.go` (new)
- `backend-go/services/scm-integration-service/internal/adapter/githubapi/*.go` (star + PR-update client calls, wherever the existing GitHub REST client lives)
- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_scm.go` (2 new channels: `github.starOrca`, `github.updatePRTitle`)
**Status:** 🚧 Proposed — no code written

---

## `github.starOrca` — deciding the routing question BUG-012 leaves open

BUG-012 explicitly raises this as a decision point: should `starOrca` go through the per-tenant OAuth client
at all, since starring the Orca repo "isn't really a tenant-scoped GitHub operation," or would a lighter-weight
fixed-app-token fire-and-forget from `api-gateway` be more appropriate?

**Decision: route through the per-tenant OAuth client, same as every other `github.*` RPC. No fixed-token
path, no new proto-free shortcut.** This is not a stylistic preference — it follows from what GitHub's actual
API does, checked directly rather than assumed:

- GitHub's star endpoint (`PUT /user/starred/{owner}/{repo}`) stars the repo **on behalf of whichever identity
  authenticated the call** — there is no "star this repo as the Orca app/org" concept separate from some
  actual GitHub account's own starred-repos list. A fixed service-level token would star the repo as
  whatever GitHub account that token belongs to (e.g. a bot account), not as the user who clicked "star" in
  Orca's UI — which is a materially different, arguably confusing product behavior from what `starOrca`'s
  name and its `source` parameter (`runtime-github-client.ts:79-88`, e.g. `'landing-page'`/`'support-section'`)
  imply: the point is capturing that *this user* starred the repo, as a small goodwill/growth signal, not
  recording that some backend robot did.
- This is the exact same constraint `github.checkOrcaStarred`'s own honest no-op already lives with — checking
  "is the repo starred" (`GET /user/starred/{owner}/{repo}`) is equally a **per-user** question on GitHub's
  API, which is presumably why that channel was left as a `nil, nil` no-op rather than answered with some
  shared/fixed credential in the first place. `starOrca` is that same channel's write-side twin
  (`channels_scm.go:59-70`'s own comment already calls it exactly that) — it inherits the same per-user
  requirement, not a different, lighter one.
- **backend-go's whole `scm-integration-service` design is already "per-tenant OAuth API client, no shared
  credential"** (`scmintegration.proto:7-8`). A fixed-app-token path for `starOrca` would be the *first*
  shared-credential exception carved into that design — reintroducing, in miniature, exactly the
  shared-credential shape `missing-v1/BUG-012`'s carried-over security note was originally worried about for
  the *old* TS backend's `gh` CLI shell-out. Nothing about `starOrca` specifically justifies being the one
  exception; it fits the existing per-tenant-OAuth pattern cleanly once a backing RPC exists.

So: no new proto-free fire-and-forget path, no fixed app token, no new secret to provision. `starOrca` gets a
real RPC using the same OAuth credential every other `github.*` mutation already resolves via
`attachSCMIdentity`/`(tenant, provider, user)`-scoped credentials.

```protobuf
// scmintegration.proto — additive

service ScmIntegrationService {
  // ... existing RPCs ...

  // StarRepository — github.starOrca (and, incidentally, a natural backing
  // RPC for github.checkOrcaStarred's currently-honest nil,nil no-op,
  // channels_scm.go:59-70 — not required by this proposal's scope, but the
  // same OAuth scope/token this RPC needs also answers that read, so a
  // CheckRepositoryStarred sibling RPC is a natural, low-cost follow-up
  // once this lands; not designed here since BUG-012 assigns only the
  // write side).
  rpc StarRepository(StarRepositoryRequest) returns (StarRepositoryResponse);

  // UpdatePullRequest — github.updatePRTitle. Plain (repo, number) address,
  // mirroring UpdateIssueRequest's shape (scmintegration.proto:316-326)
  // exactly, NOT UpdatePullRequestBySlug's Projects-v2-item addressing
  // (scmintegration.proto:491-494) — see "Why not UpdatePullRequestBySlug"
  // below.
  rpc UpdatePullRequest(UpdatePullRequestRequest) returns (PullRequest);
}

message StarRepositoryRequest {
  string tenant_id = 1;
  ScmProvider provider = 2; // GitHub-only today (starOrca's only caller), but
                              // parameterized like every other RPC here rather
                              // than hardcoded, per this proto's existing
                              // convention (e.g. GetRateLimitStatusRequest).
  string repo = 3;           // "owner/name" slug — always "getorca/orca" (or
                              // equivalent) for this call site's actual use,
                              // but not hardcoded server-side: the usecase
                              // takes whatever repo the caller resolved,
                              // consistent with every other repo-addressed
                              // RPC on this service never baking in a
                              // specific repo name.
}

message StarRepositoryResponse {
  bool starred = 1; // true once the API call succeeds — GitHub's star
                      // endpoint is idempotent (starring an already-starred
                      // repo still 204s), so this is always true on success,
                      // never meaningfully false; kept as an explicit field
                      // (rather than google.protobuf.Empty) so a future
                      // provider without a star concept could return false
                      // instead of erroring, without a wire-shape change.
}

message UpdatePullRequestRequest {
  string tenant_id = 1;
  ScmProvider provider = 2;
  string repo = 3;
  int32 number = 4;
  optional string title = 5; // only field github.updatePRTitle's actual
                               // wire shape sends today (api-types.ts:1605-
                               // 1610); optional + additional PATCH-able
                               // fields (body, base, state) can be added
                               // later the same way UpdateIssueRequest grew
                               // its own optional fields incrementally,
                               // without a breaking change.
}
```

---

## Why `StarRepository` doesn't need `UpdateIssueRequest`'s full field set

Unlike `UpdateIssueRequest` (title/body/state/labels/assignees — a real multi-field PATCH), starring has
exactly one meaningful input (which repo) and one meaningful side effect (starred or not) — there's no partial
update semantics to design for. Keeping `StarRepositoryRequest` to `(tenant_id, provider, repo)` avoids
inventing unused optionality.

```go
// usecase/star_repository.go
type StarRepositoryInput struct {
	TenantID string
	Provider domain.ScmProvider
	Repo     string // "owner/name"
}

type StarRepository struct {
	credentials CredentialResolver // resolves (tenant, provider, user) -> OAuth token, same port every
	                                 // other mutation usecase already depends on
	github      GitHubClient        // existing REST client port
}

func (uc *StarRepository) Execute(ctx context.Context, identity usecase.Identity, in StarRepositoryInput) (bool, error) {
	token, err := uc.credentials.Resolve(ctx, in.TenantID, identity.UserID, in.Provider)
	if err != nil {
		return false, err
	}
	if err := uc.github.StarRepo(ctx, token, in.Repo); err != nil { // PUT /user/starred/{owner}/{repo}
		return false, err
	}
	return true, nil
}
```

---

## `github.updatePRTitle` — why `UpdatePullRequest`, not `UpdatePullRequestBySlug`

BUG-012 already traced this precisely: `UpdatePullRequestBySlug` (`scmintegration.proto:66`, request at
`:491-494`) addresses a **GitHub Projects v2 board item** by slug, a fundamentally different GitHub API
surface from a plain PR. Two concrete reasons this proposal does not reuse it, both already surfaced in
BUG-012 and confirmed against the proto:

1. **Wrong return type.** `UpdatePullRequestBySlug` returns `WorkItemDetails` (a Projects-v2 concept), not
   `PullRequest`. `github.updatePRTitle`'s frontend contract is `Promise<boolean>`
   (`api-types.ts:1605-1610`) — neither return type is what the wire contract wants, but `PullRequest` is at
   least the correct domain object to derive a success boolean from; `WorkItemDetails` isn't a PR at all.
2. **Wrong addressing scheme, and not always resolvable.** A PR not added to any Projects v2 board has no
   slug — `github.updatePRTitle`'s actual callers (title inline-edit on a PR panel, per
   `runtime-github-client.ts:26-41`'s call site) have no reason to require the PR be on a project board first.
   Resolving `(repo, prNumber)` → slug as a prerequisite step would add a real API round trip and a real
   failure mode (no slug exists) to a UI action that today has no dependency on GitHub Projects at all.

The correct sibling to build against is `UpdateIssueRequest` (`scmintegration.proto:316-326`) — same
provider-parameterized, plain `(tenant_id, provider, repo, number)` address, same `optional` field pattern for
partial updates, same "mutate via a narrow RPC on the underlying REST resource" shape as `MergePullRequest`/
`RequestPullRequestReviewers`/`SetPullRequestAutoMerge` already use for other PR fields. `UpdatePullRequest`
is exactly that shape, scoped to `title` for now (see `UpdatePullRequestRequest`'s doc comment above for why
it's additive-ready for `body`/`base`/`state` later without another design pass).

```go
// usecase/update_pull_request.go
type UpdatePullRequestInput struct {
	TenantID string
	Provider domain.ScmProvider
	Repo     string
	Number   int32
	Title    *string
}

type UpdatePullRequest struct {
	credentials CredentialResolver
	github      GitHubClient
}

func (uc *UpdatePullRequest) Execute(ctx context.Context, identity usecase.Identity, in UpdatePullRequestInput) (domain.PullRequest, error) {
	token, err := uc.credentials.Resolve(ctx, in.TenantID, identity.UserID, in.Provider)
	if err != nil {
		return domain.PullRequest{}, err
	}
	// PATCH /repos/{owner}/{repo}/pulls/{number} — mirrors UpdateIssue's own
	// PATCH-the-underlying-resource shape (UpdateIssueRequest's Execute,
	// same package), just against the pulls endpoint instead of issues.
	return uc.github.UpdatePullRequest(ctx, token, in.Repo, in.Number, githubapi.PullRequestPatch{
		Title: in.Title,
	})
}
```

---

## Wiring both channels in `channels_scm.go`

```go
// channels_scm.go — add to registerGitHubChannels

// github.starOrca — the write-side twin of github.checkOrcaStarred's
// honest nil,nil no-op (see this file's own comment at the top of this
// function group): unlike checkOrcaStarred, this one now has a real
// backing RPC (see SOL-012), so it is wired for real rather than staying
// a stub.
r.Register("github.starOrca", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
	type starArgs struct {
		Source string `json:"source"`
	}
	// source (runtime-github-client.ts:79-88's caller-supplied UI-location
	// tag, e.g. "landing-page") is accepted for wire-shape compatibility but
	// not forwarded to scm-integration-service — GitHub's star API has no
	// concept of "why," and this service does not log/analytics-track
	// per-call metadata (see scm-integration-service.md §2's "stateless-ish"
	// framing). If starOrca's source ever needs to be recorded for product
	// analytics, that belongs in a telemetry event emitted here in
	// api-gateway, not as a new scm-integration-service RPC field.
	_, _ = decodeArg[starArgs](args, 0)

	rpcCtx, cancel := context.WithTimeout(ctx, scmRPCTimeout)
	defer cancel()
	resp, err := client.StarRepository(attachSCMIdentity(rpcCtx, id), &scmintegrationv1.StarRepositoryRequest{
		TenantId: id.TenantID, Provider: scmintegrationv1.ScmProvider_SCM_PROVIDER_GITHUB,
		Repo: orcaRepoSlug, // a package-level const, e.g. "getorca/orca" — the one repo this channel ever stars
	})
	if err != nil {
		return nil, err
	}
	return resp.GetStarred(), nil
})

// github.updatePRTitle
r.Register("github.updatePRTitle", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
	type updateTitleArgs struct {
		Repo   string `json:"repo"` // "id:<repoId>" | "<repoPath>" — same resolveGitHubOwnerRepo-shaped
		                             // input github.listWorkItems already handles (channels_scm.go)
		Number int32  `json:"prNumber"`
		Title  string `json:"title"`
	}
	in, err := decodeArg[updateTitleArgs](args, 0)
	if err != nil {
		return nil, err
	}
	owner, name, err := resolveGitHubOwnerRepo(ctx, id, gitClient, in.Repo) // reuse the same repo-resolution
	if err != nil {                                                          // helper listWorkItems/mergePR use
		return nil, err
	}
	rpcCtx, cancel := context.WithTimeout(ctx, scmRPCTimeout)
	defer cancel()
	title := in.Title
	_, err = client.UpdatePullRequest(attachSCMIdentity(rpcCtx, id), &scmintegrationv1.UpdatePullRequestRequest{
		TenantId: id.TenantID, Provider: scmintegrationv1.ScmProvider_SCM_PROVIDER_GITHUB,
		Repo: fmt.Sprintf("%s/%s", owner, name), Number: in.Number, Title: &title,
	})
	if err != nil {
		return nil, err
	}
	return true, nil // github.updatePRTitle's frontend contract is Promise<boolean>
	                    // (api-types.ts:1605-1610); the RPC's real PullRequest
	                    // response is discarded in favor of a plain success bool,
	                    // consistent with the frontend never reading a body here.
})
```

`resolveGitHubOwnerRepo` is named after (and assumed to already exist as) the same helper
`github.listWorkItems` uses to turn its `repo` field's `"id:<repoId>"`-or-path shape into an owner/repo pair
(`channels_scm.go`'s own comment on `listWorkItems` names this exact resolution need) — `updatePRTitle` sends
the identical wire shape (`repo: id:<repoId> | <repoPath>`, per BUG-012's own citation of
`api-types.ts:1605-1610`), so this proposal reuses that existing resolution path rather than duplicating it.

---

## Test plan

- `scm-integration-service`:
  - `star_repository_test.go` — fake `CredentialResolver`/`GitHubClient`: asserts `Execute` resolves the
    caller's own `(tenant, user, provider)` credential (not some fixed token), asserts the repo slug is
    passed through unmodified, asserts a credential-resolution failure (no OAuth connected) propagates as an
    error rather than silently no-opping.
  - `update_pull_request_test.go` — same fake-port shape: asserts `Title` is optional (nil input title sends
    no PATCH field), asserts the underlying `github.UpdatePullRequest` call receives `(repo, number)`
    unchanged from the request.
- `channels_scm_test.go`:
  - `github.starOrca`: fake `ScmIntegrationServiceClient` — asserts the relayed `Repo` is always the fixed
    Orca-repo constant regardless of `source`'s value, asserts a missing/empty `source` arg does not fail the
    call (it's accepted-but-unused, not required).
  - `github.updatePRTitle`: fake client + fake `resolveGitHubOwnerRepo` path — asserts both `repo: "id:..."`
    and `repo: "<owner>/<name>"` input shapes resolve correctly, asserts the channel returns `true` on RPC
    success regardless of the RPC's actual `PullRequest` body content, asserts an RPC error propagates as a
    channel error (not silently swallowed into `false`).

## References

- `backend-go/proto/orca/scmintegration/v1/scmintegration.proto:7-8` — the per-tenant-OAuth, no-shared-credential design principle this proposal's `starOrca` routing decision is grounded in
- `backend-go/proto/orca/scmintegration/v1/scmintegration.proto:316-326` — `UpdateIssueRequest`, the plain-address/optional-field sibling shape `UpdatePullRequestRequest` mirrors
- `backend-go/proto/orca/scmintegration/v1/scmintegration.proto:66,491-494` — `UpdatePullRequestBySlug`, the wrong-addressing-scheme candidate this proposal explicitly does not reuse, and why
- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_scm.go:59-70` — `github.checkOrcaStarred`'s existing honest `nil, nil` no-op, the read-side twin of the gap this proposal closes on the write side
- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_scm.go:172-180,243-263,281-294` — `requestPRReviewers`/`updateIssue`/`prForBranch`'s existing wiring shape, the pattern `updatePRTitle`'s handler follows
- `specs/backend-go/tdd/services/scm-integration-service.md:6-20` — "direct per-tenant OAuth API clients — NOT a CLI shell-out," "stateless-ish" (§2) framing this proposal's scope decisions (no source-tracking field, no shared token) are grounded in
- `frontend/src/renderer/src/runtime/runtime-github-client.ts:26-41,79-88` — both call sites' exact wire shapes (`{source}` for starOrca, `{repo, prNumber, title}` for updatePRTitle)
- `frontend/src/preload/api-types.ts:1605-1610` — `updatePRTitle`'s `Promise<boolean>` return contract, why the channel discards the RPC's `PullRequest` body
- `specs/backend-go/bugs/missing-v1/BUG-012-github-channels-not-implemented.md` — predecessor report; carries the shared-credential security note this proposal confirms is architecturally moot for backend-go (per BUG-012 in this directory) and does not reintroduce via a fixed-token shortcut
- `specs/backend-go/bugs/missing-v3/BUG-012-github-starorca-updateprtitle-not-implemented.md` — the bug this resolves, including the explicit routing-decision question this proposal answers
