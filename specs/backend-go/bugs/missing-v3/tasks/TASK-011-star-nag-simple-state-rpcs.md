# TASK-011: `DismissStarNag`/`DeferStarNag`/`CompleteStarNag`/`DisableStarNag`/`ForceShowStarNag`/`NotifyStarNagOnboardingCompleted` — proto + usecases + wscompat wiring

**From Solution:** SOL-005
**Priority:** P1 — first RPC group to land once TASK-009/010 exist; independent of the GitHub-adjacent RPCs in TASK-012
**Service:** `tenant-service` (proto, usecase, grpc adapter) + `api-gateway` (`wscompat` wiring)
**File:** `backend-go/proto/orca/tenant/v1/tenant.proto`, `backend-go/services/tenant-service/internal/usecase/star_nag_actions.go` (new), `backend-go/services/tenant-service/internal/usecase/star_nag_actions_test.go` (new), `backend-go/services/tenant-service/internal/adapter/grpc/server.go`, `backend-go/services/api-gateway/internal/adapter/wscompat/channels_star_nag.go` (new), `backend-go/services/api-gateway/internal/adapter/wscompat/channels.go`, `backend-go/services/api-gateway/cmd/server/main.go`
**Depends on:** TASK-009, TASK-010
**Status:** `[x]` DONE — implemented as specified. Deviation: `ListTeamsForUser` was already present in `tenant.proto`/`server.go`/`main.go` from a prior (logic-v1) pass, unrelated to this task — only additive edits were made around it. The 6 GitHub-adjacent-free RPCs (`star_nag_actions.go`) were written together with TASK-012's 4 in one file/one pass (both tasks landed in the same session) rather than strictly sequentially. `buf generate`, `go build`/`go vet` clean on tenant-service + api-gateway; usecase tests and wscompat channel tests (`TestStarNag*`) all pass; one pre-existing `fakeTenantServiceClient` in `httpgateway/tenant_routes_test.go` (no embedded interface) needed 10 new stub methods added to keep compiling after the `TenantServiceClient` interface grew — done, `go vet ./services/api-gateway/...` clean.

---

## Context

Of the 10 `starNag.*` frontend-callable methods (BUG-005), 6 are pure
state-mutation calls with no GitHub-star dependency: `dismiss`, `later`,
`complete`, `disable`, `forceShow`, `onboardingCompleted`. SOL-005 designs
these as near-identical empty-request/empty-response RPCs sharing one
`Defer`-shaped usecase for dismiss/later (differing only in a telemetry
outcome tag) and independent, simple state transitions for the rest. This
task ships all 6, split from the GitHub-adjacent 4 (TASK-012) so the two can
be reviewed and land independently.

## Changes to make

### Step 1 — `tenant.proto`: 6 new RPCs

Add to `service TenantService` (`tenant.proto:11-64`), after the existing
`ResolveCompanyByEmailDomain` line, following this file's own convention of
a short "why this exists" comment block per RPC group (see the
`GetOnboardingState`/SSO-follow-up sections for the exact style):

```protobuf
  // ── starNag.* surface (BUG-005/SOL-005) ───────────────────────────────
  // Per-user "star Orca on GitHub" nag state — dismissal/cooldown/threshold/
  // completion — folded into tenant-service per SOL-005's "small per-user
  // preference state, no natural owning service" verdict, same shape as
  // GetOnboardingState/SetOnboardingState above. Every request carries only
  // user_id (never company_id — same convention as GetOnboardingStateRequest:
  // the scoping company comes from tenant.RequireTenantID(ctx), not a
  // message field).
  rpc DismissStarNag(DismissStarNagRequest) returns (google.protobuf.Empty);
  rpc DeferStarNag(DeferStarNagRequest) returns (google.protobuf.Empty); // "later"
  rpc CompleteStarNag(CompleteStarNagRequest) returns (google.protobuf.Empty);
  rpc DisableStarNag(DisableStarNagRequest) returns (google.protobuf.Empty);
  rpc ForceShowStarNag(ForceShowStarNagRequest) returns (google.protobuf.Empty);
  rpc NotifyStarNagOnboardingCompleted(NotifyStarNagOnboardingCompletedRequest) returns (google.protobuf.Empty);
```

And the messages, alongside the other request message defs later in the
file:

```protobuf
message DismissStarNagRequest {
  string user_id = 1;
}

message DeferStarNagRequest {
  string user_id = 1;
}

message CompleteStarNagRequest {
  string user_id = 1;
}

message DisableStarNagRequest {
  string user_id = 1;
}

message ForceShowStarNagRequest {
  string user_id = 1;
}

message NotifyStarNagOnboardingCompletedRequest {
  string user_id = 1;
}
```

Regenerate:

```bash
cd backend-go/proto
buf generate
```

### Step 2 — `star_nag_actions.go`: usecases

Create `backend-go/services/tenant-service/internal/usecase/star_nag_actions.go`,
following `onboarding_state.go`'s style (company scoping via
`tenant.RequireTenantID(ctx)`, `apperrors.New` for every failure path):

```go
package usecase

import (
	"context"
	"time"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/common/tenant"
	"github.com/stablyai/orca-go/services/tenant-service/internal/domain"
)

// DeferStarNag backs both starNag.dismiss ("dismissed" outcome) and
// starNag.later ("later" outcome) — the old TS backend's dismiss() is
// itself defer('dismissed') (service.ts:307-309); telemetry emission for
// the outcome distinction is BUG-014/SOL-014's concern, not this usecase's
// (see SOL-005's own note on MAIN_OWNED_TELEMETRY_EVENTS excluding
// star_nag_outcome from the telemetry.track RPC path).
type DeferStarNag struct {
	repo StarNagStateRepository
}

func NewDeferStarNag(repo StarNagStateRepository) *DeferStarNag {
	return &DeferStarNag{repo: repo}
}

func (uc *DeferStarNag) Execute(ctx context.Context, userID string) error {
	companyID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return apperrors.New(apperrors.KindUnauthenticated, "TENANT_NO_TENANT", "no tenant in request context", err)
	}
	state, err := uc.repo.GetOrCreate(ctx, companyID, userID)
	if err != nil {
		return apperrors.New(apperrors.KindInternal, "TENANT_STAR_NAG_LOAD_FAILED", "failed to load star nag state", err)
	}
	if state.ActivePrompt == nil {
		// Mirrors service.ts:313-316: no active session, nothing to defer.
		return nil
	}
	state.NextThreshold *= 2
	state.BaselineAgents = nil // recomputed on next threshold check — see SOL-005's "Explicitly out of scope" section
	deferredUntil := time.Now().Add(domain.StarNagCooldown)
	state.DeferredUntil = &deferredUntil
	state.ActivePrompt = nil
	if err := uc.repo.Save(ctx, state); err != nil {
		return apperrors.New(apperrors.KindInternal, "TENANT_STAR_NAG_SAVE_FAILED", "failed to save star nag state", err)
	}
	// TASK-014 wires the visibility_changed "hide" publish here.
	return nil
}

// CompleteStarNag backs starNag.complete — permanent suppression
// (service.ts:384-391): starred or opted out for good.
type CompleteStarNag struct {
	repo StarNagStateRepository
}

func NewCompleteStarNag(repo StarNagStateRepository) *CompleteStarNag {
	return &CompleteStarNag{repo: repo}
}

func (uc *CompleteStarNag) Execute(ctx context.Context, userID string) error {
	companyID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return apperrors.New(apperrors.KindUnauthenticated, "TENANT_NO_TENANT", "no tenant in request context", err)
	}
	state, err := uc.repo.GetOrCreate(ctx, companyID, userID)
	if err != nil {
		return apperrors.New(apperrors.KindInternal, "TENANT_STAR_NAG_LOAD_FAILED", "failed to load star nag state", err)
	}
	state.Completed = true
	state.DeferredUntil = nil
	state.ActivePrompt = nil
	if err := uc.repo.Save(ctx, state); err != nil {
		return apperrors.New(apperrors.KindInternal, "TENANT_STAR_NAG_SAVE_FAILED", "failed to save star nag state", err)
	}
	return nil
}

// DisableStarNag backs starNag.disable — same terminal shape as Complete
// (service.ts:384-391 covers both under one branch); kept as its own
// usecase (not an alias) because the two are semantically distinct actions
// even though today's persisted effect is identical, matching the old TS
// backend's own two-methods-one-effect shape.
type DisableStarNag struct {
	repo StarNagStateRepository
}

func NewDisableStarNag(repo StarNagStateRepository) *DisableStarNag {
	return &DisableStarNag{repo: repo}
}

func (uc *DisableStarNag) Execute(ctx context.Context, userID string) error {
	companyID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return apperrors.New(apperrors.KindUnauthenticated, "TENANT_NO_TENANT", "no tenant in request context", err)
	}
	state, err := uc.repo.GetOrCreate(ctx, companyID, userID)
	if err != nil {
		return apperrors.New(apperrors.KindInternal, "TENANT_STAR_NAG_LOAD_FAILED", "failed to load star nag state", err)
	}
	state.Completed = true
	state.DeferredUntil = nil
	state.ActivePrompt = nil
	if err := uc.repo.Save(ctx, state); err != nil {
		return apperrors.New(apperrors.KindInternal, "TENANT_STAR_NAG_SAVE_FAILED", "failed to save star nag state", err)
	}
	return nil
}

// ForceShowStarNag backs starNag.forceShow — unconditional show, no
// GitHub check, no gating beyond "not already visible" (service.ts:397-407).
type ForceShowStarNag struct {
	repo StarNagStateRepository
}

func NewForceShowStarNag(repo StarNagStateRepository) *ForceShowStarNag {
	return &ForceShowStarNag{repo: repo}
}

func (uc *ForceShowStarNag) Execute(ctx context.Context, userID string) error {
	companyID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return apperrors.New(apperrors.KindUnauthenticated, "TENANT_NO_TENANT", "no tenant in request context", err)
	}
	state, err := uc.repo.GetOrCreate(ctx, companyID, userID)
	if err != nil {
		return apperrors.New(apperrors.KindInternal, "TENANT_STAR_NAG_LOAD_FAILED", "failed to load star nag state", err)
	}
	if state.ActivePrompt != nil {
		return nil // already visible — no-op, per service.ts:397-407
	}
	state.ActivePrompt = &domain.ActiveStarNagPrompt{Source: "force_show", Mode: "gh", Surface: "card", ShownAt: time.Now()}
	if err := uc.repo.Save(ctx, state); err != nil {
		return apperrors.New(apperrors.KindInternal, "TENANT_STAR_NAG_SAVE_FAILED", "failed to save star nag state", err)
	}
	// TASK-014 wires the visibility_changed "show" publish here.
	return nil
}

// NotifyStarNagOnboardingCompleted backs starNag.onboardingCompleted — the
// old TS backend's onboardingCompleted() (service.ts:275). Records the
// event by refreshing app_version so a later threshold/value-moment check
// can tell onboarding has happened; it does NOT itself show a prompt
// (showing on onboarding completion, if desired, is the frontend's own
// agent-value-moment flow calling starNag.agentValueMoment separately —
// see TASK-012).
type NotifyStarNagOnboardingCompleted struct {
	repo StarNagStateRepository
}

func NewNotifyStarNagOnboardingCompleted(repo StarNagStateRepository) *NotifyStarNagOnboardingCompleted {
	return &NotifyStarNagOnboardingCompleted{repo: repo}
}

func (uc *NotifyStarNagOnboardingCompleted) Execute(ctx context.Context, userID string) error {
	companyID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return apperrors.New(apperrors.KindUnauthenticated, "TENANT_NO_TENANT", "no tenant in request context", err)
	}
	// GetOrCreate alone is enough to record "this user's row now exists" —
	// there is no dedicated onboarding-completed column on StarNagState
	// (see domain.StarNagState); this is intentionally a cheap no-op today,
	// flagged (not hidden) as a real design gap: BUG-005's own "Explicitly
	// out of scope" section notes the threshold auto-trigger has no
	// backend-go event source at all, and onboarding-completion firing a
	// prompt automatically would need that same missing event plumbing.
	if _, err := uc.repo.GetOrCreate(ctx, companyID, userID); err != nil {
		return apperrors.New(apperrors.KindInternal, "TENANT_STAR_NAG_LOAD_FAILED", "failed to load star nag state", err)
	}
	return nil
}
```

Add `NewDeferStarNag`'s outcome-tagging note: `DismissStarNag`'s RPC handler
and `DeferStarNag`'s RPC handler both call the same `*DeferStarNag` usecase
— there is no separate `DismissStarNag` usecase type, matching
`service.ts:307-309`'s "dismiss is defer('dismissed')" shape.

### Step 3 — `internal/usecase/star_nag_actions_test.go`

One test per usecase against a fake `StarNagStateRepository` (add a
`fakeStarNagStateRepository` to this package's test file, following
`fakes_test.go`'s `fakeUserProfileRepository` shape):

- `DeferStarNag.Execute` with an `ActivePrompt` set: doubles
  `NextThreshold`, sets `DeferredUntil` ~3 days out, clears `ActivePrompt`
  and `BaselineAgents`.
- `DeferStarNag.Execute` with `ActivePrompt == nil`: no-op, `Save` never
  called.
- `CompleteStarNag`/`DisableStarNag`: `Completed=true`, `DeferredUntil=nil`,
  `ActivePrompt=nil`.
- `ForceShowStarNag` when `ActivePrompt` already set: no-op (`Save` never
  called). When nil: sets `ActivePrompt{Source:"force_show", Mode:"gh",
  Surface:"card"}`.
- `NotifyStarNagOnboardingCompleted`: calls `GetOrCreate`, no error.

### Step 4 — `internal/adapter/grpc/server.go`: wire the 6 RPCs

Add the 6 usecases as `Server` fields (same pattern as
`getOnboardingState`/`setOnboardingState` at `server.go` lines ~151-167) and
implement each method, e.g.:

```go
func (s *Server) DismissStarNag(ctx context.Context, req *tenantv1.DismissStarNagRequest) (*emptypb.Empty, error) {
	if err := s.deferStarNag.Execute(ctx, req.GetUserId()); err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &emptypb.Empty{}, nil
}

func (s *Server) DeferStarNag(ctx context.Context, req *tenantv1.DeferStarNagRequest) (*emptypb.Empty, error) {
	if err := s.deferStarNag.Execute(ctx, req.GetUserId()); err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &emptypb.Empty{}, nil
}

func (s *Server) CompleteStarNag(ctx context.Context, req *tenantv1.CompleteStarNagRequest) (*emptypb.Empty, error) {
	if err := s.completeStarNag.Execute(ctx, req.GetUserId()); err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &emptypb.Empty{}, nil
}

func (s *Server) DisableStarNag(ctx context.Context, req *tenantv1.DisableStarNagRequest) (*emptypb.Empty, error) {
	if err := s.disableStarNag.Execute(ctx, req.GetUserId()); err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &emptypb.Empty{}, nil
}

func (s *Server) ForceShowStarNag(ctx context.Context, req *tenantv1.ForceShowStarNagRequest) (*emptypb.Empty, error) {
	if err := s.forceShowStarNag.Execute(ctx, req.GetUserId()); err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &emptypb.Empty{}, nil
}

func (s *Server) NotifyStarNagOnboardingCompleted(ctx context.Context, req *tenantv1.NotifyStarNagOnboardingCompletedRequest) (*emptypb.Empty, error) {
	if err := s.notifyStarNagOnboardingCompleted.Execute(ctx, req.GetUserId()); err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &emptypb.Empty{}, nil
}
```

Update `New(...)` (the `Server` constructor) to take the 5 new usecase
pointers (`deferStarNag`, `completeStarNag`, `disableStarNag`,
`forceShowStarNag`, `notifyStarNagOnboardingCompleted`) and
`cmd/server/main.go`'s call site to construct and pass them — mirror exactly
how `getOnboardingStateUC`/`setOnboardingStateUC` are constructed
(`main.go:142-143`) and threaded into `tenantgrpc.New(...)` (`main.go:150`),
using the same `profiles`/repository variable this file already has in
scope, plus a new `starNagRepo := tenantpostgres.NewStarNagStateRepository(pool)`
(TASK-010) line near `profiles := tenantpostgres.NewUserProfileRepository(pool)`.

### Step 5 — `channels_star_nag.go`: wscompat wiring

Create `backend-go/services/api-gateway/internal/adapter/wscompat/channels_star_nag.go`,
following `channels_scm.go`'s file-header convention (why this is a separate
file, what it's called from) and `channels_onboarding.go`'s
`attachTenantIdentity`-via-`gatewaygrpc.AttachIdentity` pattern:

```go
// Channel handlers backing the frontend's starNag.* namespace — see
// specs/backend-go/bugs/missing-v3/solutions/SOL-005-starnag-channels.md.
// This file covers the 6 pure state-mutation RPCs (dismiss/later/complete/
// disable/forceShow/onboardingCompleted); the 4 GitHub-adjacent RPCs
// (openWeb/starOrca/agentValueMoment/showAgentValueMoment) and the
// subscribe/unsubscribe streaming pair are wired from their own files —
// see channels_star_nag_github.go (TASK-012) and
// channels_star_nag_visibility.go (TASK-014). registerStarNagChannels is
// the entry point channels.go's RegisterRealChannels calls.
package wscompat

import (
	"context"
	"encoding/json"

	tenantv1 "github.com/stablyai/orca-go/proto/gen/go/orca/tenant/v1"

	gatewaygrpc "github.com/stablyai/orca-go/services/api-gateway/internal/adapter/grpc"
	"github.com/stablyai/orca-go/services/api-gateway/internal/usecase"
)

func attachTenantIdentity(ctx context.Context, id Identity) context.Context {
	return gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
}

func registerStarNagChannels(r *Registry, client tenantv1.TenantServiceClient) {
	r.Register("starNag.dismiss", func(ctx context.Context, id Identity, _ []json.RawMessage) (any, error) {
		_, err := client.DismissStarNag(attachTenantIdentity(ctx, id), &tenantv1.DismissStarNagRequest{UserId: id.UserID})
		return nil, err
	})
	r.Register("starNag.later", func(ctx context.Context, id Identity, _ []json.RawMessage) (any, error) {
		_, err := client.DeferStarNag(attachTenantIdentity(ctx, id), &tenantv1.DeferStarNagRequest{UserId: id.UserID})
		return nil, err
	})
	r.Register("starNag.complete", func(ctx context.Context, id Identity, _ []json.RawMessage) (any, error) {
		_, err := client.CompleteStarNag(attachTenantIdentity(ctx, id), &tenantv1.CompleteStarNagRequest{UserId: id.UserID})
		return nil, err
	})
	r.Register("starNag.disable", func(ctx context.Context, id Identity, _ []json.RawMessage) (any, error) {
		_, err := client.DisableStarNag(attachTenantIdentity(ctx, id), &tenantv1.DisableStarNagRequest{UserId: id.UserID})
		return nil, err
	})
	r.Register("starNag.forceShow", func(ctx context.Context, id Identity, _ []json.RawMessage) (any, error) {
		_, err := client.ForceShowStarNag(attachTenantIdentity(ctx, id), &tenantv1.ForceShowStarNagRequest{UserId: id.UserID})
		return nil, err
	})
	r.Register("starNag.onboardingCompleted", func(ctx context.Context, id Identity, _ []json.RawMessage) (any, error) {
		_, err := client.NotifyStarNagOnboardingCompleted(attachTenantIdentity(ctx, id), &tenantv1.NotifyStarNagOnboardingCompletedRequest{UserId: id.UserID})
		return nil, err
	})
}
```

(A single generic `func starNagUnaryHandler(call func(...) (*emptypb.Empty,
error)) ChannelHandler` helper — as SOL-005's own sketch proposes — cannot
actually be written this way in Go: each RPC has a distinct
`*tenantv1.XRequest` type, not a shared `*emptypb.Empty` request, so a
generic helper would need a type parameter per request type, which buys
little over the 6 explicit 3-line bodies above. Write them explicit, not
generic — matches `channels_scm.go`'s own per-RPC-explicit style rather than
forcing an abstraction the real request types don't support for free.)

### Step 6 — wire into `channels.go` and `main.go`

`channels.go`'s `RegisterRealChannels` already calls
`registerTelemetryChannels(r)` at line 136 and has `tenantClient` in scope
(passed in as a parameter, already used by `registerDevServerAccessControlChannels`/
`registerOnboardingChannels`). Add, right after `registerOnboardingChannels(r, infraFleetClient, tenantClient)`:

```go
	registerStarNagChannels(r, tenantClient)
```

No `main.go` change needed beyond what already exists — `tenantClient` is
already dialed and passed into `RegisterRealChannels` (`main.go:246-249`);
this task only adds a new call inside that existing function, not a new
dial or a new `RegisterRealChannels` parameter.

## Verify

```bash
cd backend-go/proto && buf generate && cd ..
go build ./services/tenant-service/... ./services/api-gateway/...
go vet ./services/tenant-service/... ./services/api-gateway/...
go test ./services/tenant-service/internal/usecase/... -run TestDeferStarNag -run TestCompleteStarNag -run TestDisableStarNag -run TestForceShowStarNag -run TestNotifyStarNagOnboardingCompleted -count=1 -v
go test ./services/api-gateway/internal/adapter/wscompat/... -run TestStarNag -count=1 -v
```
