# TASK-028: Implement `onboarding.detectAgentsAllServers` as a fan-out loop over `onboardingDetectAgents`

**From Solution:** SOL-010
**Priority:** P1 — independent of TASK-027 (doesn't use `relayOnboardingDevServerOp`), but reuses the existing `onboardingDetectAgents` function directly, so land after confirming that function's real signature (done below) rather than guessing it
**Service:** `api-gateway`
**File:** `backend-go/services/api-gateway/internal/adapter/wscompat/channels_onboarding.go`, `backend-go/services/api-gateway/internal/adapter/wscompat/channels_onboarding_test.go`
**Depends on:** none (does not require TASK-027's helper; safe to land independently or in either order)
**Status:** `[x]` DONE. Deviation from the sketch: `onboardingDetectAgentsAllServers` also resolves and passes `TeamIds` (via `tenantClient.ListTeamsForUser`), not just `DepartmentId` — `devServer.listForUser` in this same package was fixed under BUG-013 to include team-granted dev servers too (that RPC and fix were already live in the codebase at pickup time), so omitting `TeamIds` here would have made this fan-out see a narrower dev-server set than the caller's own `devServer.listForUser` view for no reason. Added a matching `listTeamsForUserFunc` override to the local `fakeTenantServiceClientForOnboarding` test double (defaults to an empty response when unset, so existing single-field test setup didn't need changes). `go build`/`go vet`/`go test -run TestOnboardingDetectAgentsAllServers` all clean.

---

## Context

Unlike the other 3 relay-copy channels (TASK-027), `onboarding.detectAgentsAllServers`
is not a single agent RPC — per BUG-010, it's the old TS backend's
`detectAgentsAllDevServers` fan-out (`desktop/src/main/ipc/onboarding-ipc.ts:111-141`):
enumerate every dev server the caller can see, call the same per-server
`preflight.detectAgents` relay `onboardingDetectAgents` already does, once per server,
merge into a `Record<devServerId, {agents, platform, error?}>`. The caller-visible
dev-server set already has a backend-go answer — `infra-fleet-service.ListDevServersForUser`,
the same RPC `devServer.listForUser` uses (`channels_dev_server_access_control.go:275-306`)
— so this handler composes two already-implemented primitives rather than adding new
enumeration logic.

## Changes to make

### Step 1 — confirm the real `onboardingDetectAgents` signature and result type

Read directly from `channels_onboarding.go` (verbatim, current):

```go
func onboardingDetectAgents(
	ctx context.Context,
	id Identity,
	client infrafleetv1.InfraFleetServiceClient,
	args []json.RawMessage,
) (any, error) {
	...
	return onboardingDetectAgentsResult{
		Agents:      relayResult.Agents,
		Platform:    relayResult.Platform,
		DevServerID: in.DevServerID,
	}, nil
}

type onboardingDetectAgentsResult struct {
	Agents      []string `json:"agents"`
	Platform    *string  `json:"platform"`
	DevServerID string   `json:"devServerId"`
}

type onboardingDetectAgentsArgs struct {
	DevServerID string           `json:"devServerId"`
	Commands    []map[string]any `json:"commands"`
}
```

This confirms the fan-out can call `onboardingDetectAgents` directly (it already takes
`(ctx, id, client, args)` and returns `(any, error)` where the `any` is always a
concrete `onboardingDetectAgentsResult` on the success path — the type assertion below
is safe).

### Step 2 — add the fan-out handler

Add to `channels_onboarding.go`:

```go
type onboardingDetectAgentsAllServersResult struct {
	Agents   []string `json:"agents"`
	Platform *string  `json:"platform"`
	Error    *string  `json:"error,omitempty"`
}

// onboardingDetectAgentsAllServers fans onboardingDetectAgents out across
// every dev server the caller can see (via the same GetUserProfile ->
// ListDevServersForUser path devServer.listForUser uses,
// channels_dev_server_access_control.go:275-306), merging results keyed by
// devServerId — the backend-go equivalent of the old TS backend's
// detectAgentsAllDevServers (desktop/src/main/ipc/onboarding-ipc.ts:111-141).
//
// Deliberately narrower than the old handler in two ways, both scope-only
// (see SOL-010 for the full reasoning): no client-side 60s detection cache
// (onboardingDetectAgents itself has none either, so adding one only here
// would make single-server and all-server detection inconsistent), and no
// pre-filter to "connected" dev servers only (onboardingDetectAgents'
// existing FailedPrecondition handling already answers "not connected" as
// an empty-agents result per server, so a filter would only save an RPC
// round trip, not change correctness).
func onboardingDetectAgentsAllServers(
	ctx context.Context, id Identity,
	fleetClient infrafleetv1.InfraFleetServiceClient, tenantClient tenantv1.TenantServiceClient,
	args []json.RawMessage,
) (map[string]onboardingDetectAgentsAllServersResult, error) {
	in := decodeOptionalArg[onboardingDetectAgentsArgs](args, 0) // commands, same catalog every call site sends

	gwCtx := gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID, Role: id.Role})
	profileCtx, profileCancel := context.WithTimeout(gwCtx, rpcTimeout)
	defer profileCancel()
	profileResp, err := tenantClient.GetUserProfile(profileCtx, &tenantv1.GetUserProfileRequest{UserId: id.UserID})
	if err != nil {
		return nil, err
	}
	listCtx, listCancel := context.WithTimeout(gwCtx, rpcTimeout)
	defer listCancel()
	listResp, err := fleetClient.ListDevServersForUser(listCtx, &infrafleetv1.ListDevServersForUserRequest{
		DepartmentId: profileResp.GetProfile().GetDepartmentId(),
	})
	if err != nil {
		return nil, err
	}

	out := make(map[string]onboardingDetectAgentsAllServersResult, len(listResp.GetDevServers()))
	for _, ds := range listResp.GetDevServers() {
		devServerID := ds.GetId()
		perServerArgs, marshalErr := json.Marshal(onboardingDetectAgentsArgs{DevServerID: devServerID, Commands: in.Commands})
		if marshalErr != nil {
			errStr := marshalErr.Error()
			out[devServerID] = onboardingDetectAgentsAllServersResult{Agents: []string{}, Error: &errStr}
			continue
		}
		result, detectErr := onboardingDetectAgents(ctx, id, fleetClient, []json.RawMessage{perServerArgs})
		if detectErr != nil {
			errStr := detectErr.Error()
			out[devServerID] = onboardingDetectAgentsAllServersResult{Agents: []string{}, Error: &errStr}
			continue
		}
		typed := result.(onboardingDetectAgentsResult)
		out[devServerID] = onboardingDetectAgentsAllServersResult{Agents: typed.Agents, Platform: typed.Platform}
	}
	return out, nil
}
```

Note: `onboardingDetectAgents` itself already tolerates `FailedPrecondition` (agent not
connected) by returning a non-error, empty-agents `onboardingDetectAgentsResult` — so
the `detectErr != nil` branch above only ever fires for a genuinely unexpected error
(e.g. an unknown `devServerId`), not the routine "not connected yet" case, which flows
through the success path with `Agents: []string{}` already set by
`onboardingDetectAgents` itself.

### Step 3 — register the channel

Add to `registerOnboardingChannels`, alongside the other new registrations from
TASK-027:

```go
	r.Register("onboarding.detectAgentsAllServers", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		return onboardingDetectAgentsAllServers(ctx, id, infraFleetClient, tenantClient, args)
	})
```

`tenantClient` is already a parameter of `registerOnboardingChannels`
(`channels_onboarding.go:156-160`, confirmed current) — no signature change needed.

### Step 4 — tests

Add to `channels_onboarding_test.go` (created by TASK-027; if this task lands first,
create it with just this test and a package-level `argsJSON` reuse from
`channels_test.go`):

```go
func TestOnboardingDetectAgentsAllServers_MergesPerServerResults(t *testing.T) {
	fleet := &fakeInfraFleetClient{
		listDevServersForUserFunc: func(ctx context.Context, in *infrafleetv1.ListDevServersForUserRequest) (*infrafleetv1.ListDevServersForUserResponse, error) {
			return &infrafleetv1.ListDevServersForUserResponse{DevServers: []*infrafleetv1.DevServer{
				{Id: "ds-1"}, {Id: "ds-2"}, {Id: "ds-3"},
			}}, nil
		},
		relayByDevServerFunc: func(ctx context.Context, in *infrafleetv1.RelayByDevServerRequest) (*infrafleetv1.RelayResponse, error) {
			switch in.GetDevServerId() {
			case "ds-1":
				return &infrafleetv1.RelayResponse{ResultJson: `{"agents":["claude","codex"]}`}, nil
			case "ds-2":
				return nil, status.Error(codes.FailedPrecondition, "not connected")
			default: // ds-3
				return nil, status.Error(codes.Internal, "boom")
			}
		},
	}
	tenant := &fakeTenantServiceClientForOnboarding{
		getUserProfileFunc: func(ctx context.Context, in *tenantv1.GetUserProfileRequest) (*tenantv1.GetUserProfileResponse, error) {
			return &tenantv1.GetUserProfileResponse{Profile: &tenantv1.UserProfile{DepartmentId: "dept-1"}}, nil
		},
	}
	r := NewRegistry()
	registerOnboardingChannels(r, fleet, tenant)

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1", UserID: "user-1"}, "onboarding.detectAgentsAllServers", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	byServer, ok := result.(map[string]onboardingDetectAgentsAllServersResult)
	if !ok {
		t.Fatalf("unexpected result type %T", result)
	}
	if len(byServer) != 3 {
		t.Fatalf("want 3 entries, got %d: %+v", len(byServer), byServer)
	}
	if len(byServer["ds-1"].Agents) != 2 || byServer["ds-1"].Error != nil {
		t.Errorf("ds-1: want 2 agents, no error, got %+v", byServer["ds-1"])
	}
	if byServer["ds-2"].Agents == nil || len(byServer["ds-2"].Agents) != 0 || byServer["ds-2"].Error != nil {
		t.Errorf("ds-2 (not connected): want empty-not-nil agents, no error (onboardingDetectAgents' own FailedPrecondition tolerance), got %+v", byServer["ds-2"])
	}
	if byServer["ds-3"].Error == nil {
		t.Errorf("ds-3: want a non-nil error surfaced for the genuine RPC failure, got %+v", byServer["ds-3"])
	}
	if byServer["ds-3"].Agents == nil {
		t.Errorf("ds-3: want a non-nil (empty) agents slice even on error")
	}
}
```

`fakeTenantServiceClientForOnboarding` is a new, minimal fake local to this test file
— mirror `fakeTenantServiceClientForAdmin`'s exact shape (`channels_admin_users_test.go:14-25`,
embed the nil `tenantv1.TenantServiceClient` interface, override only `GetUserProfile`):

```go
type fakeTenantServiceClientForOnboarding struct {
	tenantv1.TenantServiceClient
	getUserProfileFunc func(context.Context, *tenantv1.GetUserProfileRequest) (*tenantv1.GetUserProfileResponse, error)
}

func (f *fakeTenantServiceClientForOnboarding) GetUserProfile(ctx context.Context, in *tenantv1.GetUserProfileRequest, _ ...grpc.CallOption) (*tenantv1.GetUserProfileResponse, error) {
	return f.getUserProfileFunc(ctx, in)
}
```

## Verify

```bash
cd backend-go
go build ./services/api-gateway/...
go vet ./services/api-gateway/...
go test ./services/api-gateway/internal/adapter/wscompat/... -run TestOnboardingDetectAgentsAllServers -v -count=1
```
