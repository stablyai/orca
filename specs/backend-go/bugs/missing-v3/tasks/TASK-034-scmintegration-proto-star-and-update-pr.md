# TASK-034: Add `StarRepository` and `UpdatePullRequest` RPCs to `scmintegration.proto`

**From Solution:** SOL-012
**Priority:** P0 — proto-only; both TASK-035 and TASK-036 need the generated Go types this task produces before their usecase/wiring code can compile
**Service:** `scm-integration-service` (proto)
**File:** `backend-go/proto/orca/scmintegration/v1/scmintegration.proto`
**Depends on:** none
**Status:** `[x]` DONE — as specified. `buf generate` produced `UpdatePullRequestRequest`/`StarRepositoryRequest`/`StarRepositoryResponse` and the 2 new client/server methods exactly as sketched; `go build ./proto/... ./services/scm-integration-service/... ./services/api-gateway/...` is clean (the pre-existing `buf lint` style warnings about reused `PullRequest`/`Issue` response types are unrelated pre-existing findings across the whole file, not from this change).

---

## Context

BUG-012 confirmed `scmintegration.proto` has no "star a repo" RPC of any kind
(`grep -n '^  rpc' ... | grep -i star` → no match) and no generic plain-address
`UpdatePullRequest` RPC — the closest candidate, `UpdatePullRequestBySlug`, addresses a
GitHub Projects v2 board item by slug (a different GitHub API surface, returns
`WorkItemDetails` not `PullRequest`), not a bare `(repo, number)` pair. SOL-012 designs
both as real per-tenant-OAuth RPCs (no fixed-token shortcut — see SOL-012's routing
decision for `starOrca`), with `UpdatePullRequestRequest` shaped to mirror
`UpdateIssueRequest` exactly, confirmed against the real current proto below.

## Changes to make

### Step 1 — add the 2 RPCs to `service ScmIntegrationService`

Real current RPC list around `UpdateIssue` (verbatim, `scmintegration.proto:36-43`):

```protobuf
  // GitHub PR/issue mutations — github.mergePR / github.requestPRReviewers /
  // github.removePRReviewers / github.setPRAutoMerge / github.updateIssue.
  // See SOL-012 "Design — Proto additions, shape 1".
  rpc MergePullRequest(MergePullRequestRequest) returns (MergePullRequestResponse);
  rpc RequestPullRequestReviewers(RequestPullRequestReviewersRequest) returns (PullRequest);
  rpc RemovePullRequestReviewers(RemovePullRequestReviewersRequest) returns (PullRequest);
  rpc SetPullRequestAutoMerge(SetPullRequestAutoMergeRequest) returns (PullRequest);
  rpc UpdateIssue(UpdateIssueRequest) returns (Issue);
```

Add immediately after `rpc UpdateIssue(...)` (still inside the same GitHub
PR/issue-mutations group):

```protobuf
  // UpdatePullRequest — github.updatePRTitle. Plain (repo, number) address,
  // mirroring UpdateIssueRequest's shape immediately above (title-only for
  // now, additive-ready for body/base/state later) — NOT
  // UpdatePullRequestBySlug's Projects-v2-item addressing (this file, see
  // UpdatePullRequestBySlugRequest below): a PR not added to any Projects
  // v2 board has no slug, and github.updatePRTitle's actual callers have no
  // dependency on GitHub Projects at all.
  rpc UpdatePullRequest(UpdatePullRequestRequest) returns (PullRequest);

  // StarRepository — github.starOrca. Routes through the same per-tenant
  // OAuth client every other RPC on this service uses (no fixed-app-token
  // shortcut — see SOL-012's routing-decision section): GitHub's star
  // endpoint (PUT /user/starred/{owner}/{repo}) stars the repo on behalf of
  // whichever identity authenticated the call, so there is no "star this
  // repo as the Orca app" concept separate from an actual connected GitHub
  // account. The natural backing RPC for github.checkOrcaStarred's existing
  // honest nil,nil no-op (channels_scm.go:59-70) too, though a
  // CheckRepositoryStarred sibling isn't added here — out of this task's
  // scope, a low-cost follow-up once this lands.
  rpc StarRepository(StarRepositoryRequest) returns (StarRepositoryResponse);
```

### Step 2 — add the 3 new messages

Real current `UpdateIssueRequest` (verbatim, `scmintegration.proto:316-327`, the shape
`UpdatePullRequestRequest` mirrors):

```protobuf
message UpdateIssueRequest {
  string tenant_id = 1;
  ScmProvider provider = 2;
  string repo = 3;
  int32 number = 4;
  optional string title = 5;
  optional string body = 6;
  optional string state = 7;
  repeated string add_labels = 8;
  repeated string remove_labels = 9;
  repeated string assignees = 10;
}
```

Add, immediately after `UpdateIssueRequest`'s closing `}` (before
`GetPullRequestForBranchRequest`):

```protobuf
message UpdatePullRequestRequest {
  string tenant_id = 1;
  ScmProvider provider = 2;
  string repo = 3;
  int32 number = 4;
  // Only field github.updatePRTitle's actual wire shape sends today
  // (frontend/src/preload/api-types.ts:1605-1610) — optional + additional
  // PATCH-able fields (body, base, state) can be added later the same way
  // UpdateIssueRequest grew its own optional fields incrementally, without
  // a breaking change.
  optional string title = 5;
}

message StarRepositoryRequest {
  string tenant_id = 1;
  // GitHub-only today (starOrca's only caller), but parameterized like
  // every other RPC on this service rather than hardcoded, per this
  // proto's existing convention (e.g. GetRateLimitStatusRequest).
  ScmProvider provider = 2;
  string repo = 3; // "owner/name" slug — always the Orca repo for this
                    // call site's actual use, but not hardcoded
                    // server-side: the usecase takes whatever repo the
                    // caller resolved, consistent with every other
                    // repo-addressed RPC on this service never baking in a
                    // specific repo name.
}

message StarRepositoryResponse {
  // true once the API call succeeds — GitHub's star endpoint is
  // idempotent (starring an already-starred repo still 204s), so this is
  // always true on success, never meaningfully false; kept as an explicit
  // field (rather than google.protobuf.Empty) so a future provider
  // without a star concept could return false instead of erroring,
  // without a wire-shape change.
  bool starred = 1;
}
```

`UpdatePullRequest`'s RPC signature returns the existing `PullRequest` message
(`scmintegration.proto:139-146`, unchanged) — no new response message needed for it.

### Step 3 — regenerate Go code

```bash
cd backend-go/proto
buf lint
buf generate
```

Confirm the generated types land in
`backend-go/proto/gen/go/orca/scmintegration/v1/scmintegration.pb.go` (or the
equivalent generated filename already used by this module — check
`proto/buf.gen.yaml`'s configured output path if unsure) with
`StarRepositoryRequest`/`StarRepositoryResponse`/`UpdatePullRequestRequest` and the 2
new `ScmIntegrationServiceClient`/`ScmIntegrationServiceServer` methods
(`StarRepository`, `UpdatePullRequest`).

## Verify

```bash
cd backend-go
make proto-gen
make proto-lint
go build ./proto/...
```

Also run a full build of every module that imports the regenerated proto package, to
catch any now-required `UnimplementedScmIntegrationServiceServer` embedding gap before
TASK-035/TASK-036 implement the real handlers:

```bash
go build ./services/scm-integration-service/... ./services/api-gateway/...
```

Expected: `scm-integration-service`'s `grpc.Server` (which embeds
`scmintegrationv1.UnimplementedScmIntegrationServiceServer`) still compiles — the
generated `Unimplemented...` methods satisfy the interface for the 2 new RPCs until
TASK-035/TASK-036 add real handlers.
