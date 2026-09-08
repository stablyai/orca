# TASK-012: `ScmStarCheckPort` stub + `OpenWebStarNag`/`StarOrcaFromNag`/`PrepareStarNagAgentValueMoment`/`ShowPreparedStarNagAgentValueMoment` — ships today, no SOL-012 dependency

**From Solution:** SOL-005
**Priority:** P1 — parallel to TASK-011, same prerequisite (TASK-009/010); independent of TASK-013 (the real-RPC swap)
**Service:** `tenant-service` (proto, usecase, adapter, grpc) + `api-gateway` (`wscompat` wiring)
**File:** `backend-go/proto/orca/tenant/v1/tenant.proto`, `backend-go/services/tenant-service/internal/usecase/ports.go`, `backend-go/services/tenant-service/internal/usecase/star_nag_actions.go`, `backend-go/services/tenant-service/internal/usecase/star_nag_actions_test.go`, `backend-go/services/tenant-service/internal/adapter/scmstarcheck/stub_adapter.go` (new), `backend-go/services/tenant-service/internal/adapter/grpc/server.go`, `backend-go/services/tenant-service/cmd/server/main.go`, `backend-go/services/api-gateway/internal/adapter/wscompat/channels_star_nag_github.go` (new), `backend-go/services/api-gateway/internal/adapter/wscompat/channels.go`
**Depends on:** TASK-009, TASK-010
**Status:** `[x]` DONE — implemented as specified, including the task's own Step 4 correction (added `app_version` to `PrepareStarNagAgentValueMomentRequest`). Real deviation found and documented in code: confirmed against the actual `runtime-star-nag-client.ts`/`web-preload-api.ts` call sites that the frontend's `starNag.agentValueMoment` call sends an EMPTY params object today (no `appVersion` field at all) — not the `{appVersion}` shape this task assumed. The wscompat channel still decodes `appVersion` defensively (forward-compatible, and correct if/when the frontend starts sending it), but today it always resolves to `""`, which degrades `PrepareStarNagAgentValueMoment`'s "one attempt per app version" gate to "one attempt ever" — a safe, conservative degradation (documented in `channels_star_nag_github.go`'s comment), not a correctness bug, so the RPC still ships. `buf generate`, `go build`/`go vet` clean on tenant-service + api-gateway; usecase tests and wscompat channel tests (`TestStarNag*`, including a dedicated empty-args test) all pass.

---

## Context

The remaining 4 of the 10 `starNag.*` methods — `openWeb`, `starOrca`,
`agentValueMoment` (`PrepareStarNagAgentValueMoment`), and
`showAgentValueMoment` (`ShowPreparedStarNagAgentValueMoment`) — all touch
the "does this user have Orca starred on GitHub" question. **No
`ScmIntegrationService` RPC for that exists today** (confirmed by BUG-012:
`scmintegration.proto`'s 24 RPCs have no `Star`/`star` match) — `SOL-012` is
where that RPC gets specified, in a different agent's task range. SOL-005
explicitly designs this NOT to block on that: a `ScmStarCheckPort`
usecase-level interface with a stub adapter returning the same
`ok=false` ("unable to determine") answer `github.checkOrcaStarred`
(`channels_scm.go:56-70`) already gives today. **This task ships all 4 RPCs
now, fully functional in their web-fallback path.** TASK-013 is the
separate, later task that swaps the stub adapter for a real one once
SOL-012's RPC exists — no usecase code changes there, only the adapter.

## Changes to make

### Step 1 — `tenant.proto`: 4 new RPCs

Add to `service TenantService`, same block as TASK-011's additions:

```protobuf
  rpc OpenWebStarNag(OpenWebStarNagRequest) returns (google.protobuf.Empty);
  // StarOrcaFromNag performs (or attempts) the actual GitHub star action.
  // starred=false + ok=false (see StarOrcaFromNagResponse) means "unable to
  // determine/perform" — not an error — same shape as
  // github.checkOrcaStarred's null today (channels_scm.go:56-70).
  rpc StarOrcaFromNag(StarOrcaFromNagRequest) returns (StarOrcaFromNagResponse);
  rpc PrepareStarNagAgentValueMoment(PrepareStarNagAgentValueMomentRequest) returns (StarNagAgentValueMomentPreparation);
  rpc ShowPreparedStarNagAgentValueMoment(ShowPreparedStarNagAgentValueMomentRequest) returns (google.protobuf.Empty);
```

Messages:

```protobuf
message OpenWebStarNagRequest {
  string user_id = 1;
}

message StarOrcaFromNagRequest {
  string user_id = 1;
}

message StarOrcaFromNagResponse {
  bool starred = 1;
}

message PrepareStarNagAgentValueMomentRequest {
  string user_id = 1;
}

// StarNagAgentValueMomentPreparation mirrors the old TS backend's
// AgentValueMomentPreparation wire shape (agent-value-moment.ts).
message StarNagAgentValueMomentPreparation {
  string status = 1; // "ready" | "skipped"
  string mode = 2;   // "gh" | "web" — only meaningful when status == "ready"
}

message ShowPreparedStarNagAgentValueMomentRequest {
  string user_id = 1;
}
```

Regenerate: `cd backend-go/proto && buf generate`.

### Step 2 — `ports.go`: `ScmStarCheckPort`

Add to `tenant-service/internal/usecase/ports.go`, near
`StarNagStateRepository` (TASK-010):

```go
// ScmStarCheckPort answers "has this user starred Orca on GitHub" and
// "star it on their behalf" — usecase-level port per
// architecture/03-clean-architecture-guidelines.md, because
// scm-integration-service has no RPC for either question today (BUG-012).
// ok=false means "unable to determine" (no such RPC yet, or the user has no
// linked GitHub OAuth account) — the same designed degrade-to-unknown
// answer github.checkOrcaStarred already gives (channels_scm.go:56-70), NOT
// an error. See internal/adapter/scmstarcheck's stub implementation
// (this task) and TASK-013 (the future real implementation, once SOL-012
// ships ScmIntegrationService.StarRepository).
type ScmStarCheckPort interface {
	CheckStarred(ctx context.Context, userID string) (starred bool, ok bool)
	StarRepository(ctx context.Context, userID string) (starred bool, ok bool)
}
```

### Step 3 — stub adapter

Create `backend-go/services/tenant-service/internal/adapter/scmstarcheck/stub_adapter.go`:

```go
// Package scmstarcheck implements usecase.ScmStarCheckPort. StubAdapter is
// the only implementation until SOL-012 ships
// ScmIntegrationService.StarRepository — see TASK-013
// (specs/backend-go/bugs/missing-v3/tasks/) for the future real adapter
// this package will gain alongside this stub, wired by cmd/server/main.go's
// own decision of which to construct.
package scmstarcheck

import "context"

// StubAdapter always returns ok=false ("unable to determine/perform") — the
// same honest interim answer api-gateway's github.checkOrcaStarred channel
// already gives (channels_scm.go:56-70), not a fabricated result.
type StubAdapter struct{}

func NewStubAdapter() *StubAdapter { return &StubAdapter{} }

func (StubAdapter) CheckStarred(ctx context.Context, userID string) (bool, bool) {
	return false, false
}

func (StubAdapter) StarRepository(ctx context.Context, userID string) (bool, bool) {
	return false, false
}
```

### Step 4 — usecases (append to `star_nag_actions.go`, TASK-011's file)

```go
// OpenWebStarNag backs starNag.openWeb — opening GitHub is only a handoff,
// not verified star success (service.ts:342-354): sets a cooldown WITHOUT
// setting Completed, unlike Complete/Disable.
type OpenWebStarNag struct {
	repo StarNagStateRepository
}

func NewOpenWebStarNag(repo StarNagStateRepository) *OpenWebStarNag {
	return &OpenWebStarNag{repo: repo}
}

func (uc *OpenWebStarNag) Execute(ctx context.Context, userID string) error {
	companyID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return apperrors.New(apperrors.KindUnauthenticated, "TENANT_NO_TENANT", "no tenant in request context", err)
	}
	state, err := uc.repo.GetOrCreate(ctx, companyID, userID)
	if err != nil {
		return apperrors.New(apperrors.KindInternal, "TENANT_STAR_NAG_LOAD_FAILED", "failed to load star nag state", err)
	}
	deferredUntil := time.Now().Add(domain.StarNagCooldown)
	state.DeferredUntil = &deferredUntil
	state.ActivePrompt = nil
	if err := uc.repo.Save(ctx, state); err != nil {
		return apperrors.New(apperrors.KindInternal, "TENANT_STAR_NAG_SAVE_FAILED", "failed to save star nag state", err)
	}
	return nil
}

// StarOrcaFromNag backs starNag.starOrca. See ScmStarCheckPort's doc
// comment: ok=false (today, always, via StubAdapter) degrades to
// starred=false — matches the frontend's existing "web fallback" UI path,
// no error surfaced.
type StarOrcaFromNag struct {
	repo      StarNagStateRepository
	starCheck ScmStarCheckPort
}

func NewStarOrcaFromNag(repo StarNagStateRepository, starCheck ScmStarCheckPort) *StarOrcaFromNag {
	return &StarOrcaFromNag{repo: repo, starCheck: starCheck}
}

func (uc *StarOrcaFromNag) Execute(ctx context.Context, userID string) (bool, error) {
	starred, ok := uc.starCheck.StarRepository(ctx, userID)
	if !ok {
		return false, nil
	}
	if starred {
		companyID, err := tenant.RequireTenantID(ctx)
		if err != nil {
			return false, apperrors.New(apperrors.KindUnauthenticated, "TENANT_NO_TENANT", "no tenant in request context", err)
		}
		state, err := uc.repo.GetOrCreate(ctx, companyID, userID)
		if err != nil {
			return false, apperrors.New(apperrors.KindInternal, "TENANT_STAR_NAG_LOAD_FAILED", "failed to load star nag state", err)
		}
		state.Completed = true
		state.DeferredUntil = nil
		state.ActivePrompt = nil
		if err := uc.repo.Save(ctx, state); err != nil {
			return false, apperrors.New(apperrors.KindInternal, "TENANT_STAR_NAG_SAVE_FAILED", "failed to save star nag state", err)
		}
	}
	return starred, nil
}

// PrepareStarNagAgentValueMoment backs starNag.agentValueMoment. With
// ok=false (today's stub), takes the exact branch the old TS backend takes
// for starred===null: {status:"ready", mode:"web"} (agent-value-moment.ts:48-50).
// Skips (status:"skipped") when already Completed or a cooldown is active
// or a prompt is already visible, or this app version already had a value
// moment attempt.
type PrepareStarNagAgentValueMoment struct {
	repo      StarNagStateRepository
	starCheck ScmStarCheckPort
}

func NewPrepareStarNagAgentValueMoment(repo StarNagStateRepository, starCheck ScmStarCheckPort) *PrepareStarNagAgentValueMoment {
	return &PrepareStarNagAgentValueMoment{repo: repo, starCheck: starCheck}
}

type StarNagAgentValueMomentPreparation struct {
	Status string // "ready" | "skipped"
	Mode   string // "gh" | "web", only when Status == "ready"
}

func (uc *PrepareStarNagAgentValueMoment) Execute(ctx context.Context, userID, appVersion string) (StarNagAgentValueMomentPreparation, error) {
	companyID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return StarNagAgentValueMomentPreparation{}, apperrors.New(apperrors.KindUnauthenticated, "TENANT_NO_TENANT", "no tenant in request context", err)
	}
	state, err := uc.repo.GetOrCreate(ctx, companyID, userID)
	if err != nil {
		return StarNagAgentValueMomentPreparation{}, apperrors.New(apperrors.KindInternal, "TENANT_STAR_NAG_LOAD_FAILED", "failed to load star nag state", err)
	}
	if state.Completed || state.ActivePrompt != nil ||
		(state.DeferredUntil != nil && state.DeferredUntil.After(time.Now())) ||
		(state.AgentValueMomentAppVersion != nil && *state.AgentValueMomentAppVersion == appVersion) {
		return StarNagAgentValueMomentPreparation{Status: "skipped"}, nil
	}
	mode := "web"
	if starred, ok := uc.starCheck.CheckStarred(ctx, userID); ok && !starred {
		mode = "gh"
	}
	state.AgentValueMomentAppVersion = &appVersion
	if err := uc.repo.Save(ctx, state); err != nil {
		return StarNagAgentValueMomentPreparation{}, apperrors.New(apperrors.KindInternal, "TENANT_STAR_NAG_SAVE_FAILED", "failed to save star nag state", err)
	}
	return StarNagAgentValueMomentPreparation{Status: "ready", Mode: mode}, nil
}

// ShowPreparedStarNagAgentValueMoment backs starNag.showAgentValueMoment —
// marks the prepared moment as now actively displayed.
type ShowPreparedStarNagAgentValueMoment struct {
	repo StarNagStateRepository
}

func NewShowPreparedStarNagAgentValueMoment(repo StarNagStateRepository) *ShowPreparedStarNagAgentValueMoment {
	return &ShowPreparedStarNagAgentValueMoment{repo: repo}
}

func (uc *ShowPreparedStarNagAgentValueMoment) Execute(ctx context.Context, userID string) error {
	companyID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return apperrors.New(apperrors.KindUnauthenticated, "TENANT_NO_TENANT", "no tenant in request context", err)
	}
	state, err := uc.repo.GetOrCreate(ctx, companyID, userID)
	if err != nil {
		return apperrors.New(apperrors.KindInternal, "TENANT_STAR_NAG_LOAD_FAILED", "failed to load star nag state", err)
	}
	state.ActivePrompt = &domain.ActiveStarNagPrompt{Source: "agent_value_moment", Mode: "web", Surface: "toast", ShownAt: time.Now()}
	if err := uc.repo.Save(ctx, state); err != nil {
		return apperrors.New(apperrors.KindInternal, "TENANT_STAR_NAG_SAVE_FAILED", "failed to save star nag state", err)
	}
	return nil
}
```

Note the `PrepareStarNagAgentValueMomentRequest`/RPC as specified carries
only `user_id`, but the usecase above also needs `appVersion` (for the
"one attempt per app version" gate) — add `app_version` as a second field
on `PrepareStarNagAgentValueMomentRequest` in Step 1 before finalizing this
task (`string app_version = 2;`), sourced frontend-side the same way
`onboarding.update`'s `FlowVersion` already threads an app-version-like
value through its own request. Do not ship this RPC with `user_id` only —
the skip/ready gate is unimplementable without it.

### Step 5 — usecase tests (append to `star_nag_actions_test.go`)

Add a `fakeScmStarCheckPort` (configurable `starred`/`ok` return per
method). Cover:
- `OpenWebStarNag`: sets `DeferredUntil` WITHOUT `Completed`.
- `StarOrcaFromNag`: `ok=false` → `(false, nil)`, state untouched;
  `ok=true, starred=true` → `(true, nil)`, `Completed=true`;
  `ok=true, starred=false` → `(false, nil)`, state untouched.
- `PrepareStarNagAgentValueMoment`: `Completed=true` → `{status:"skipped"}`;
  cooldown active → `{status:"skipped"}`; same `appVersion` already
  recorded → `{status:"skipped"}`; otherwise with `starCheck.ok=false` →
  `{status:"ready", mode:"web"}` (the shippable-today path).
- `ShowPreparedStarNagAgentValueMoment`: sets `ActivePrompt`.

### Step 6 — `grpc/server.go` + `cmd/server/main.go`

Same mechanical pattern as TASK-011 Step 4: add the 4 usecases as `Server`
fields, implement the 4 RPC methods (`StarOrcaFromNag` returns
`&tenantv1.StarOrcaFromNagResponse{Starred: starred}`;
`PrepareStarNagAgentValueMoment` returns
`&tenantv1.StarNagAgentValueMomentPreparation{Status: result.Status, Mode:
result.Mode}`), and wire `main.go` to construct
`scmstarcheck.NewStubAdapter()` and pass it into
`NewStarOrcaFromNag`/`NewPrepareStarNagAgentValueMoment`.

### Step 7 — `channels_star_nag_github.go`: wscompat wiring

```go
// The 4 GitHub-adjacent starNag.* channels — see channels_star_nag.go's
// doc comment for the split rationale. StarOrcaFromNag/agentValueMoment
// have real (non-empty) response shapes, unlike TASK-011's 6.
package wscompat

import (
	"context"
	"encoding/json"

	tenantv1 "github.com/stablyai/orca-go/proto/gen/go/orca/tenant/v1"
)

func registerStarNagGitHubChannels(r *Registry, client tenantv1.TenantServiceClient) {
	r.Register("starNag.openWeb", func(ctx context.Context, id Identity, _ []json.RawMessage) (any, error) {
		_, err := client.OpenWebStarNag(attachTenantIdentity(ctx, id), &tenantv1.OpenWebStarNagRequest{UserId: id.UserID})
		return nil, err
	})
	r.Register("starNag.starOrca", func(ctx context.Context, id Identity, _ []json.RawMessage) (any, error) {
		resp, err := client.StarOrcaFromNag(attachTenantIdentity(ctx, id), &tenantv1.StarOrcaFromNagRequest{UserId: id.UserID})
		if err != nil {
			return nil, err
		}
		return resp.GetStarred(), nil
	})
	r.Register("starNag.agentValueMoment", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		var in struct {
			AppVersion string `json:"appVersion"`
		}
		if len(args) > 0 {
			_ = json.Unmarshal(args[0], &in)
		}
		resp, err := client.PrepareStarNagAgentValueMoment(attachTenantIdentity(ctx, id),
			&tenantv1.PrepareStarNagAgentValueMomentRequest{UserId: id.UserID, AppVersion: in.AppVersion})
		if err != nil {
			return nil, err
		}
		return map[string]string{"status": resp.GetStatus(), "mode": resp.GetMode()}, nil
	})
	r.Register("starNag.showAgentValueMoment", func(ctx context.Context, id Identity, _ []json.RawMessage) (any, error) {
		_, err := client.ShowPreparedStarNagAgentValueMoment(attachTenantIdentity(ctx, id), &tenantv1.ShowPreparedStarNagAgentValueMomentRequest{UserId: id.UserID})
		return nil, err
	})
}
```

Confirm the exact wire shape `frontend/src/renderer/src/runtime/runtime-star-nag-client.ts`'s
`prepareRuntimeStarNagAgentValueMoment` expects for its request arg
(`appVersion` field name assumed above — verify against that file before
finalizing) and response (`{status, mode}` assumed from BUG-005/SOL-005 —
confirm field casing matches what the frontend actually reads).

### Step 8 — wire into `channels.go`

Right after TASK-011's `registerStarNagChannels(r, tenantClient)` line:

```go
	registerStarNagGitHubChannels(r, tenantClient)
```

## Verify

```bash
cd backend-go/proto && buf generate && cd ..
go build ./services/tenant-service/... ./services/api-gateway/...
go vet ./services/tenant-service/... ./services/api-gateway/...
go test ./services/tenant-service/internal/usecase/... -run TestOpenWebStarNag -run TestStarOrcaFromNag -run TestPrepareStarNagAgentValueMoment -run TestShowPreparedStarNagAgentValueMoment -count=1 -v
go test ./services/api-gateway/internal/adapter/wscompat/... -run TestStarNag -count=1 -v
```
