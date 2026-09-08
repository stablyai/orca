# TASK-027: Wire `onboarding.detectWindowsCapabilities`/`detectGhosttyConfig`/`setGitIdentity` as verbatim relay copies of `onboardingDetectAgents`

**From Solution:** SOL-010
**Priority:** P0 — smallest, most mechanical piece of SOL-010; do first, since TASK-028/TASK-029 both benefit from the shared `relayOnboardingDevServerOp` helper this task introduces
**Service:** `api-gateway`
**File:** `backend-go/services/api-gateway/internal/adapter/wscompat/channels_onboarding.go`, `backend-go/services/api-gateway/internal/adapter/wscompat/channels_onboarding_test.go` (new)
**Depends on:** none
**Status:** `[x]` DONE — as specified. Added `relayOnboardingDevServerOp`, `windowsTerminalCapabilitiesView`, `ghosttyConfigView`, `onboardingDevServerArgs`/`setGitIdentityArgs`, and registered `onboarding.detectWindowsCapabilities`/`detectGhosttyConfig`/`setGitIdentity` in `registerOnboardingChannels`. Created `channels_onboarding_test.go` (shared with TASK-028/TASK-029, landed together in one pass) with the 5 tests from this task's sketch. `go build`/`go vet`/`go test -run TestOnboarding` all clean.

---

## Context

BUG-010 found 6 of 9 `onboarding.*` channels unregistered. Three of them —
`detectWindowsCapabilities`, `detectGhosttyConfig`, `setGitIdentity` — relay to agent
RPCs (`preflight.detectWindowsTerminalCapabilities`, `preflight.detectGhosttyConfig`,
`preflight.setGitIdentity`) that already exist and are implemented on the agent (Part
A/B parity table, `specs/agent/api/agent-rpc-catalog-runtime.md:191-199`), so this is a
pure copy of the exact resolve-then-relay skeleton `onboardingDetectAgents` already
establishes (`channels_onboarding.go:254-316`) — no new proto RPC, no new usecase.

## Changes to make

### Step 1 — add a shared relay-and-decode helper

The real current `onboardingDetectAgents` (verbatim, `channels_onboarding.go:254-316`)
already does: decode `devServerId` → reject empty → `AttachIdentity` +
`context.WithTimeout(ctx, rpcTimeout)` → `RelayByDevServer` → on
`codes.FailedPrecondition` return a zero/empty result (not an error) → otherwise
unmarshal `ResultJson`. Two of the three new channels (`detectWindowsCapabilities`,
`detectGhosttyConfig`) are this exact shape with a different agent method name and
result type and no op-specific params beyond `devServerId` — factor that shared shape
into a generic helper rather than hand-copying it twice.

Add to `channels_onboarding.go` (near `onboardingDetectAgents`):

```go
// onboardingDevServerArgs is the {devServerId} wire shape shared by every
// onboarding.* channel below that takes no other parameter.
type onboardingDevServerArgs struct {
	DevServerID string `json:"devServerId"`
}

// relayOnboardingDevServerOp is onboardingDetectAgents' resolve-then-relay
// skeleton (channels_onboarding.go's detectAgents handler), parameterized
// over the result type, for the read-only preflight.* relays that take no
// op-specific params beyond devServerId. See BUG-010: this is deliberately
// not novel design — the agent RPCs already exist and are already
// confirmed reachable (agent-rpc-catalog-runtime.md:191-199's Part A/B
// parity table); the fix is copy-and-rename.
func relayOnboardingDevServerOp[T any](
	ctx context.Context, id Identity, client infrafleetv1.InfraFleetServiceClient,
	args []json.RawMessage, agentMethod string,
) (T, error) {
	var zero T
	in, err := decodeArg[onboardingDevServerArgs](args, 0)
	if err != nil {
		return zero, err
	}
	if in.DevServerID == "" {
		return zero, fmt.Errorf("ONBOARDING_NO_DEV_SERVER: devServerId is required")
	}
	ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID, Role: id.Role})
	rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
	defer cancel()
	resp, err := client.RelayByDevServer(rpcCtx, &infrafleetv1.RelayByDevServerRequest{
		DevServerId: in.DevServerID, Method: agentMethod, ParamsJson: "{}",
	})
	if err != nil {
		// Why: "no live connection right now" is a legitimate onboarding
		// state (agent not connected yet), not an error — mirrors
		// onboardingDetectAgents' own identical tolerance immediately above
		// this function in the same file.
		if status.Code(err) == codes.FailedPrecondition {
			return zero, nil
		}
		return zero, err
	}
	var result T
	if raw := resp.GetResultJson(); raw != "" {
		if err := json.Unmarshal([]byte(raw), &result); err != nil {
			return zero, fmt.Errorf("onboarding relay(%s): decoding result: %w", agentMethod, err)
		}
	}
	return result, nil
}

// windowsTerminalCapabilitiesView mirrors frontend/src/shared/dev-server-types.ts:137-146.
type windowsTerminalCapabilitiesView struct {
	WslAvailable     bool     `json:"wslAvailable"`
	WslDistros       []string `json:"wslDistros"`
	PwshAvailable    bool     `json:"pwshAvailable"`
	PwshVersion      *string  `json:"pwshVersion"`
	GitBashAvailable bool     `json:"gitBashAvailable"`
	GitBashPath      *string  `json:"gitBashPath"`
	HostPlatform     *string  `json:"hostPlatform"`
}

// ghosttyConfigView mirrors runtime-onboarding-client.ts:97-106's return type.
type ghosttyConfigView struct {
	ConfigPath *string `json:"configPath"`
	ThemeDir   *string `json:"themeDir"`
}
```

`WslDistros` being a plain `[]string` on a non-proto value struct returned through
`Registry.Dispatch` means `normalizeNilSlices` (`registry.go:219-238`, confirmed against
the real current file) already guarantees it serializes as `[]`, not `null`, on the
"nothing detected" path — no extra nil-guard needed in this handler.

### Step 2 — register the 3 channels

Add to `registerOnboardingChannels` in `channels_onboarding.go`, after the existing
`onboarding.detectAgents` registration (real current code ends at line 234 with the
closing `})` of that handler, immediately before the function's own closing `}`):

```go
	r.Register("onboarding.detectWindowsCapabilities", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		return relayOnboardingDevServerOp[windowsTerminalCapabilitiesView](ctx, id, infraFleetClient, args, "preflight.detectWindowsTerminalCapabilities")
	})

	r.Register("onboarding.detectGhosttyConfig", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		return relayOnboardingDevServerOp[ghosttyConfigView](ctx, id, infraFleetClient, args, "preflight.detectGhosttyConfig")
	})

	// onboarding.setGitIdentity — NOT built on relayOnboardingDevServerOp:
	// it takes op-specific params (name/email) and its frontend contract is
	// void/Promise<void> (runtime-onboarding-client.ts:85-95), unlike the
	// two read-only detect* channels above — "agent not connected" here is
	// a genuine failure to surface (nothing useful to fall back to), so
	// FailedPrecondition is NOT swallowed the way relayOnboardingDevServerOp
	// swallows it.
	r.Register("onboarding.setGitIdentity", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		in, err := decodeArg[setGitIdentityArgs](args, 0)
		if err != nil {
			return nil, err
		}
		if in.DevServerID == "" {
			return nil, fmt.Errorf("ONBOARDING_NO_DEV_SERVER: devServerId is required")
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID, Role: id.Role})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		paramsJSON, err := json.Marshal(map[string]any{"name": in.Name, "email": in.Email})
		if err != nil {
			return nil, err
		}
		_, err = infraFleetClient.RelayByDevServer(rpcCtx, &infrafleetv1.RelayByDevServerRequest{
			DevServerId: in.DevServerID,
			Method:      "preflight.setGitIdentity",
			ParamsJson:  string(paramsJSON),
		})
		return nil, err
	})
```

Add the `setGitIdentityArgs` type next to `onboardingDevServerArgs`:

```go
type setGitIdentityArgs struct {
	DevServerID string `json:"devServerId"`
	Name        string `json:"name"`
	Email       string `json:"email"`
}
```

No new imports are needed — `codes`/`status` are already imported in
`channels_onboarding.go` (used by `onboardingDetectAgents`), and `infrafleetv1`/
`gatewaygrpc`/`usecase` are already imported too.

### Step 3 — tests (new file, `channels_onboarding_test.go`)

No test file exists for this package today (confirmed: `ls
channels_onboarding_test.go` fails) — `onboarding.get`/`update`/`markChecklistItem`/
`detectAgents` have never had dedicated tests. Create one, reusing the existing
`fakeInfraFleetClient` from `channels_test.go` (same package, no new fake needed —
it already has a `relayByDevServerFunc` field, confirmed at `channels_test.go:32,71-73`):

```go
package wscompat

import (
	"context"
	"testing"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	infrafleetv1 "github.com/stablyai/orca-go/proto/gen/go/orca/infrafleet/v1"
)

func TestOnboardingDetectWindowsCapabilities_RequiresDevServerID(t *testing.T) {
	r := NewRegistry()
	registerOnboardingChannels(r, &fakeInfraFleetClient{}, nil)

	_, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "onboarding.detectWindowsCapabilities", argsJSON(t, map[string]any{}))
	if err == nil {
		t.Fatal("expected an error when devServerId is omitted")
	}
}

func TestOnboardingDetectWindowsCapabilities_NotConnectedDegradesToZeroValue(t *testing.T) {
	fake := &fakeInfraFleetClient{
		relayByDevServerFunc: func(ctx context.Context, in *infrafleetv1.RelayByDevServerRequest) (*infrafleetv1.RelayResponse, error) {
			return nil, status.Error(codes.FailedPrecondition, "not connected")
		},
	}
	r := NewRegistry()
	registerOnboardingChannels(r, fake, nil)

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "onboarding.detectWindowsCapabilities",
		argsJSON(t, map[string]any{"devServerId": "ds-1"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	view, ok := result.(windowsTerminalCapabilitiesView)
	if !ok {
		t.Fatalf("unexpected result type %T", result)
	}
	if view.WslAvailable || len(view.WslDistros) != 0 {
		t.Errorf("want zero-value result, got %+v", view)
	}
}

func TestOnboardingDetectGhosttyConfig_RelaysCorrectMethod(t *testing.T) {
	var gotMethod string
	fake := &fakeInfraFleetClient{
		relayByDevServerFunc: func(ctx context.Context, in *infrafleetv1.RelayByDevServerRequest) (*infrafleetv1.RelayResponse, error) {
			gotMethod = in.GetMethod()
			return &infrafleetv1.RelayResponse{ResultJson: `{"configPath":"/home/dev/.config/ghostty/config"}`}, nil
		},
	}
	r := NewRegistry()
	registerOnboardingChannels(r, fake, nil)

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "onboarding.detectGhosttyConfig",
		argsJSON(t, map[string]any{"devServerId": "ds-1"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if gotMethod != "preflight.detectGhosttyConfig" {
		t.Errorf("want relayed method preflight.detectGhosttyConfig, got %q", gotMethod)
	}
	view := result.(ghosttyConfigView)
	if view.ConfigPath == nil || *view.ConfigPath != "/home/dev/.config/ghostty/config" {
		t.Errorf("unexpected result %+v", view)
	}
}

func TestOnboardingSetGitIdentity_NotConnectedPropagatesAsError(t *testing.T) {
	fake := &fakeInfraFleetClient{
		relayByDevServerFunc: func(ctx context.Context, in *infrafleetv1.RelayByDevServerRequest) (*infrafleetv1.RelayResponse, error) {
			return nil, status.Error(codes.FailedPrecondition, "not connected")
		},
	}
	r := NewRegistry()
	registerOnboardingChannels(r, fake, nil)

	_, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "onboarding.setGitIdentity",
		argsJSON(t, map[string]any{"devServerId": "ds-1", "name": "A", "email": "a@x.com"}))
	if err == nil {
		t.Fatal("want an error surfaced — setGitIdentity has no useful fallback for a disconnected agent, unlike the read-only detect* channels")
	}
}

func TestOnboardingSetGitIdentity_RequiresDevServerID(t *testing.T) {
	r := NewRegistry()
	registerOnboardingChannels(r, &fakeInfraFleetClient{}, nil)

	_, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "onboarding.setGitIdentity",
		argsJSON(t, map[string]any{"name": "A", "email": "a@x.com"}))
	if err == nil {
		t.Fatal("expected an error when devServerId is omitted")
	}
}
```

`registerOnboardingChannels(r, fake, nil)` passes `nil` for `tenantClient` — safe here
because none of these 3 handlers touch it (`loadOnboardingState`/`saveOnboardingState`
already nil-guard `client == nil`, confirmed at `channels_onboarding.go:117,140`, and
these 3 new handlers never call those). `argsJSON` is this package's existing test
helper (used throughout `channels_test.go`) for building a `[]json.RawMessage` from a
map.

## Verify

```bash
cd backend-go
go build ./services/api-gateway/...
go vet ./services/api-gateway/...
go test ./services/api-gateway/internal/adapter/wscompat/... -run TestOnboarding -v -count=1
```
