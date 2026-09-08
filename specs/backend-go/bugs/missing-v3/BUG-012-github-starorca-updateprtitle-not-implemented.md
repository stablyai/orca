# BUG-012: `github.starOrca` / `github.updatePRTitle` not implemented in backend-go

**Service:** `api-gateway` (WS compat layer) / `scm-integration-service` (owning gRPC service)
**File:** `backend-go/services/api-gateway/internal/adapter/wscompat/channels_scm.go`
**Severity:** Low-Medium — narrow surface (2 methods); `starOrca` is a non-critical growth/nag
feature, `updatePRTitle` is a real PR-editing action but has a workaround (edit on the
provider's web UI).
**Status:** Open, in progress as of 2026-09-07 — the proto-design half of the fix
(TASK-034: `StarRepository`/`UpdatePullRequest` RPCs) is DONE in the working tree, but it is
an **uncommitted local change** (`git status` shows `scmintegration.proto` modified, not
committed) and the usecase/adapter/server.go/wscompat wiring tasks that consume it
(TASK-035, TASK-036) are still `[ ]` TODO — so both methods are **still unregistered and
still non-functional today**, just no longer blocked on "no RPC exists at all." See
"2026-09-07 update" below before treating this as fully described by the original text.

---

## 2026-09-07 update: the proto half of this gap has since been designed (uncommitted)

Re-verifying this report's evidence on 2026-09-07 found `scmintegration.proto` now DOES
define both RPCs, with doc comments naming these exact frontend methods:

```
$ grep -n "StarRepository\|UpdatePullRequest\b" backend-go/proto/orca/scmintegration/v1/scmintegration.proto
...
  // UpdatePullRequest — github.updatePRTitle. Plain (repo, number) address, ...
  rpc UpdatePullRequest(UpdatePullRequestRequest) returns (PullRequest);
  // StarRepository — github.starOrca. Routes through the same per-tenant
  // OAuth client every other RPC on this service uses ...
  rpc StarRepository(StarRepositoryRequest) returns (StarRepositoryResponse);
```

This matches `specs/backend-go/bugs/missing-v3/tasks/TASK-034-scmintegration-proto-star-and-update-pr.md`,
marked `[x]` DONE, which added exactly these two RPCs plus `UpdatePullRequestRequest`/
`StarRepositoryRequest`/`StarRepositoryResponse` per `SOL-012`. **However**:

- `git status` shows `backend-go/proto/orca/scmintegration/v1/scmintegration.proto` as a
  locally **modified, uncommitted** file — this proto change has not landed on the
  integration branch as of this check.
- There is still no `func (s *Server) StarRepository` or `func (s *Server) UpdatePullRequest`
  anywhere in `backend-go/services/scm-integration-service/internal/adapter/grpc/server.go`
  (confirmed via grep) — the gRPC server doesn't implement either new RPC yet. This is
  `TASK-035`/`TASK-036`'s job (both usecase + adapter + `server.go` + the `channels_scm.go`
  wiring), and both tasks are still `[ ]` TODO.
- `channels_scm.go` still has no `github.starOrca`/`github.updatePRTitle` registration
  (confirmed via the same grep this report originally ran).

Net effect: **both methods are still completely non-functional today** — calling either
against a remote/backend-go-backed target still hits `notImplementedHandler`. What's changed
is that the "genuine capability gap, needs new proto design" framing below is now half
resolved (the design exists and compiles) — the remaining work is TASK-035/036's usecase +
adapter + wiring, not new RPC design. The rest of this report (below) describes the
*original* state (no RPC existed at all) and is kept for context; treat the proto-RPC
non-existence claims as historical, not current.

## Original finding (context, now superseded by the update above): `github.*` is mostly wired, but these 2 had nothing to wire to

Since `missing-v1/BUG-012` (24/24 `github.*` methods missing), `scm-integration-service`'s
proto had grown substantially — `channels_scm.go` registers `github.checkOrcaStarred`,
`github.rateLimit`, `github.listWorkItems`, `github.mergePR`, `github.prForBranch`,
`github.removePRReviewers`, `github.repoSlug`, `github.requestPRReviewers`,
`github.revokeAuth`, `github.setPRAutoMerge`, `github.startAuthLogin`, `github.updateIssue`,
plus the whole `github.project.*` family — but, at the time this report was first written,
0 of `scmintegration.proto`'s then-24 RPCs backed `starOrca` or `updatePRTitle` at all.

`github.starOrca`: Frontend `frontend/src/renderer/src/runtime/runtime-github-client.ts:79-88`
(`starRuntimeOrca`), routed to `callRuntimeRpc(target, 'github.starOrca', { source }, ...)`
whenever `target.kind === 'environment'`. This mirrors `github.checkOrcaStarred`'s own
situation, which backend-go *did* wire — but as an honest `nil, nil` no-op
(`channels_scm.go:59-70`: "scm-integration-service has no equivalent RPC ... a real port
needs a new proto RPC + usecase, not just wiring ... null is not a stub here").

`github.updatePRTitle`: Frontend `frontend/src/renderer/src/runtime/runtime-github-client.ts:26-41`
(`updateRuntimeGitHubPRTitle`), sending `{ repo: id:<repoId> | <repoPath>, prNumber, title,
prRepo }` (shape from `frontend/src/preload/api-types.ts:1605-1610`) — plain repo + PR
number addressing, distinct from `UpdatePullRequestBySlug`'s GitHub-Projects-v2 item-slug
addressing (`github.project.updatePullRequestBySlug`, already wired separately).

## Security note carried over from `missing-v1` — does NOT apply to backend-go

The old `backend-agent-execution-boundary.md` flagged `github.starOrca` as security-relevant
because the **old TS backend** self-executed the `gh` CLI in the backend process using the
backend host's **shared OS keychain** — a shared-credential path later guarded (not fixed)
by `assertLocalGhCliAllowed()` under `ORCA_MULTI_USER=1`.

That concern is **architecturally moot for backend-go**: `scm-integration-service`'s design
is explicitly "direct per-tenant OAuth API clients — NOT a CLI shell-out"
(`scmintegration.proto:7-8`, `specs/backend-go/tdd/services/scm-integration-service.md:6,20`,
already noted by `missing-v1/BUG-012`). Every registered `github.*` channel in
`channels_scm.go` goes through `attachSCMIdentity`
(`channels_scm.go:36-42`, `usecase.Identity{TenantID, UserID}`) and per-`(tenant, provider,
user)`-scoped OAuth credentials at `scm-integration-service` — there is no shared local
credential store and no `gh`/`glab` CLI shell-out anywhere in backend-go's SCM path for
`starOrca` (or anything else) to bypass. **If/when `github.starOrca` gets a real RPC, it
would naturally inherit this same per-user OAuth scoping — there is no multi-user guard to
carry forward because there is no shared-credential design left to guard against.** This is
now purely a "missing capability" finding, not also a security finding.

## Owning service verdict

`scm-integration-service` for both. As of the 2026-09-07 update, the proto RPCs
(`StarRepository`, `UpdatePullRequest`) are designed (uncommitted) — remaining work is
`TASK-035` (usecase + GitHub/GitLab/Bitbucket/Azure DevOps/Gitea adapter methods + `server.go`
+ `channels_scm.go` wiring for `StarRepository`/`github.starOrca`) and `TASK-036` (same shape
for `UpdatePullRequest`/`github.updatePRTitle`). Neither is a quick `wscompat`-only wiring
fix by itself, but both are now scoped, unblocked implementation tasks rather than open
design questions.

---

## References

- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_scm.go:56-83` — registered `github.*` channels, `checkOrcaStarred`'s honest-no-op precedent
- `backend-go/proto/orca/scmintegration/v1/scmintegration.proto:12-95` — full current RPC list (24 RPCs, no Star*/generic-UpdatePullRequest)
- `backend-go/proto/orca/scmintegration/v1/scmintegration.proto:66,491-494` — `UpdatePullRequestBySlug`, the closest-but-wrong-addressing-scheme candidate
- `frontend/src/renderer/src/runtime/runtime-github-client.ts:26-41,79-88` — both frontend call sites
- `frontend/src/preload/api-types.ts:1605-1610` — `updatePRTitle`'s plain repo+prNumber wire shape
- `specs/backend-go/bugs/missing-v1/BUG-012-github-channels-not-implemented.md` — predecessor report; carries the now-inapplicable security note this report resolves
- `specs/frontend/api/backend-agent-execution-boundary.md:124-126` — old TS backend's shared-credential `gh` CLI dispatch model (superseded)
- `specs/backend-go/bugs/missing-v3/tasks/TASK-034-scmintegration-proto-star-and-update-pr.md` — marked `[x]` DONE; added the 2 RPCs this update found in the proto
- `specs/backend-go/bugs/missing-v3/tasks/TASK-035-star-repository-usecase-and-wiring.md` — `[ ]` TODO, remaining work for `github.starOrca`
- `specs/backend-go/bugs/missing-v3/tasks/TASK-036-update-pull-request-usecase-and-wiring.md` — `[ ]` TODO, remaining work for `github.updatePRTitle`
- `specs/backend-go/bugs/missing-v3/solutions/SOL-012-github-starorca-updateprtitle.md` — the design these tasks implement
- `git status` (2026-09-07) — confirms `backend-go/proto/orca/scmintegration/v1/scmintegration.proto` is locally modified and uncommitted
