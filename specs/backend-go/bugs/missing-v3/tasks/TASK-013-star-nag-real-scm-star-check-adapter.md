# TASK-013: Swap `ScmStarCheckPort`'s stub for a real `ScmIntegrationService.StarRepository`-backed adapter

**From Solution:** SOL-005
**Priority:** P2 — deferred until its dependency exists; do not start early
**Service:** `tenant-service`
**File:** `backend-go/services/tenant-service/internal/adapter/scmstarcheck/grpc_adapter.go` (new), `backend-go/services/tenant-service/cmd/server/main.go`
**Depends on:** TASK-012 (this task's `ScmStarCheckPort` interface + `StubAdapter`) **AND the SOL-012 task that adds `ScmIntegrationService.StarRepository`** (see `../solutions/SOL-012-github-starorca-updateprtitle.md` — assigned to a different agent's task range in this same `missing-v3` batch; that task's exact `TASK-0XX` ID is not yet known at the time this file was written). **Do not start this task until that RPC exists and is merged.**
**Status:** `[x]` DONE — TASK-035 (the SOL-012 dependency) was confirmed `[x] DONE` before starting this task, per this task's own gating rule. Two real deviations from the sketch, both confirmed against the actual merged `scmintegration.proto` rather than assumed: (1) the real `StarRepository` RPC shape is `(tenant_id, provider, repo) -> {starred}` — no `Action` enum, no `user_id` field, no per-user credential resolution (confirmed at scm-integration-service's `ports.go`: `CredentialResolver` is per-(tenant, provider) only) — `GrpcAdapter.StarRepository` uses `tenant.RequireTenantID(ctx)` instead of the `userID` parameter (accepted but unused, to satisfy `ScmStarCheckPort`'s shape). (2) SOL-012 shipped ONLY the "star" RPC, explicitly NOT a "check if starred" sibling (that proto's own doc comment flags `CheckRepositoryStarred` as "out of this task's scope, a low-cost follow-up") — so `GrpcAdapter.CheckStarred` cannot be backed for real without either calling `StarRepository` (which would perform an unwanted star as a side effect of a "check" — rejected) or inventing a new proto RPC (out of this task's scope); it stays a documented, honest `ok=false` degrade, same pattern `StubAdapter`/every other star-nag path already uses. `StarRepository` itself IS real and wired: `tenant-service` gained its first outbound synchronous dependency (`ScmIntegrationServiceAddr` config field + `cmd/server/main.go` dial, mirroring git-gateway-service's own `SCMIntegrationServiceAddr`/`grpcclient.Dial` convention) — `scmstarcheck.NewGrpcAdapter(...)` replaces `NewStubAdapter()` in `main.go`. `go build`/`go vet` clean on tenant-service; new `grpc_adapter_test.go` (4 tests, including one proving `CheckStarred` never calls `StarRepository`) passes; TASK-012's `TestStarOrcaFromNag`/`TestPrepareStarNagAgentValueMoment` usecase tests re-run unmodified and still pass, confirming no usecase-layer change was needed for this swap.

---

## Context

TASK-012 shipped `starNag.starOrca`/`starNag.agentValueMoment` fully
functional today, via `ScmStarCheckPort`'s `StubAdapter` (always
`ok=false`, degrading to the frontend's existing "web fallback" UI path).
BUG-012/SOL-012 (this same `missing-v3` batch, a different agent's task
range) is where a real "check/perform star" RPC on `ScmIntegrationService`
gets specified and implemented. This task is the **second half** of that
split SOL-005 explicitly designs for: once SOL-012's RPC lands, replace
`ScmStarCheckPort`'s implementation with a real one — **no
`tenant-service` usecase logic changes**, per SOL-005's own note: "only the
adapter behind `ScmStarCheckPort` needs to change." This task file exists
now so the swap is tracked, but must not be implemented before its
dependency lands — attempting it early means guessing at
`scmintegration.proto`'s not-yet-written RPC/message names.

## Changes to make

**Before starting:** confirm SOL-012's task has landed and re-read the real,
merged `scmintegration.proto` for the exact RPC name/request/response shape
it added (this doc assumes `StarRepository`/`CheckStarred`-shaped RPCs per
SOL-012's own doc title, `github-starorca-updateprtitle.md` — do not assume
this guess is exact; grep the merged proto for the real names before writing
code).

### Step 1 — new adapter

Create `backend-go/services/tenant-service/internal/adapter/scmstarcheck/grpc_adapter.go`,
alongside `stub_adapter.go` (TASK-012) in the same package:

```go
package scmstarcheck

import (
	"context"

	scmintegrationv1 "github.com/stablyai/orca-go/proto/gen/go/orca/scmintegration/v1"
)

// GrpcAdapter implements usecase.ScmStarCheckPort against the real
// ScmIntegrationService RPC(s) SOL-012 adds. Replaces StubAdapter once
// that RPC exists — see this package's TASK-013 (specs/backend-go/bugs/
// missing-v3/tasks/) for why this file didn't exist before then.
type GrpcAdapter struct {
	client scmintegrationv1.ScmIntegrationServiceClient
}

func NewGrpcAdapter(client scmintegrationv1.ScmIntegrationServiceClient) *GrpcAdapter {
	return &GrpcAdapter{client: client}
}

// CheckStarred/StarRepository below are named to match ScmStarCheckPort's
// own method names, not necessarily 1:1 with whatever RPC method name
// SOL-012 ends up shipping — adjust the actual client.<Method> call to
// match the real generated client once known. ok=false on any RPC error or
// on a response indicating "no linked GitHub OAuth account" — never treat
// an error as "confirmed not starred" (that would be a false negative
// surfaced to the user as real information).
func (a *GrpcAdapter) CheckStarred(ctx context.Context, userID string) (starred bool, ok bool) {
	resp, err := a.client.StarRepository(ctx, &scmintegrationv1.StarRepositoryRequest{
		UserId: userID,
		Action: scmintegrationv1.StarRepositoryAction_STAR_REPOSITORY_ACTION_CHECK,
	})
	if err != nil {
		return false, false
	}
	return resp.GetStarred(), resp.GetOk()
}

func (a *GrpcAdapter) StarRepository(ctx context.Context, userID string) (starred bool, ok bool) {
	resp, err := a.client.StarRepository(ctx, &scmintegrationv1.StarRepositoryRequest{
		UserId: userID,
		Action: scmintegrationv1.StarRepositoryAction_STAR_REPOSITORY_ACTION_STAR,
	})
	if err != nil {
		return false, false
	}
	return resp.GetStarred(), resp.GetOk()
}
```

The single-RPC-with-an-`Action`-enum shape above is a guess at SOL-012's
message design (a "check" vs. "perform" distinction is exactly what
`ScmStarCheckPort`'s two methods need) — if SOL-012 instead ships two
separate RPCs (e.g. `CheckRepositoryStarred` + `StarRepository`), adjust
this adapter to call each directly instead of threading an `Action` enum
through one RPC. Either shape satisfies `ScmStarCheckPort` identically;
don't force SOL-012's real design to match this guess if it diverges.

### Step 2 — `cmd/server/main.go`: swap the wiring

Find the line TASK-012 added (`scmstarcheck.NewStubAdapter()`), and its
prerequisite: `tenant-service` needs a gRPC client dial to
`scm-integration-service`, which it likely does not have yet (check whether
`cmd/server/main.go` already dials any other service — if `tenant-service`
today makes zero outbound service calls, per `tenant-service.md` §7, this
is the FIRST outbound dependency it gains, a real architectural change
worth calling out, not a one-line swap). Replace:

```go
starCheck := scmstarcheck.NewStubAdapter()
```

with:

```go
scmConn, err := grpcclient.Dial(cfg.ScmIntegrationServiceAddr) // or whatever this service's existing dial helper/config field naming convention is — check main.go's own imports for the real helper name before assuming grpcclient.Dial
if err != nil {
	return fmt.Errorf("dialing scm-integration-service: %w", err)
}
defer func() { _ = scmConn.Close() }()
starCheck := scmstarcheck.NewGrpcAdapter(scmintegrationv1.NewScmIntegrationServiceClient(scmConn))
```

Add `cfg.ScmIntegrationServiceAddr` (or whatever `tenant-service`'s own
`internal/config` package calls its downstream-address fields — check that
package's existing shape, e.g. how `api-gateway`'s `cfg.OtherServiceAddrs`
map is populated, and whether `tenant-service` uses the same map-of-configured-addrs
convention or a flat per-service field list) alongside this service's other
configuration, following whatever pattern that config package already uses
for any *other* config value (there may be none yet, if this really is
tenant-service's first outbound dependency — confirm before assuming a
config field already has a natural home).

## Verify

```bash
cd backend-go
go build ./services/tenant-service/...
go vet ./services/tenant-service/...
go test ./services/tenant-service/internal/adapter/scmstarcheck/... -count=1 -v
```

Also re-run TASK-012's usecase tests unmodified
(`go test ./services/tenant-service/internal/usecase/... -run
TestStarOrcaFromNag -run TestPrepareStarNagAgentValueMoment -count=1 -v`) —
they must still pass against a fake `ScmStarCheckPort` exactly as written in
TASK-012, proving no usecase logic needed to change for this swap.
