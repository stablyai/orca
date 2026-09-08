# TASK-029: Implement `onboarding.getPreflightStatus` — relay to the AGENT's Contract-B `preflight.check`, NOT backend-go's own local `preflight.check` channel

**From Solution:** SOL-010
**Priority:** P0 — highest-risk task in SOL-010's set: the easy-looking wrong fix (alias the existing local `preflight.check` handler) silently ships a permanently-broken onboarding wizard step, so this must land carefully and with the regression test in Step 3
**Service:** `api-gateway`
**File:** `backend-go/services/api-gateway/internal/adapter/wscompat/channels_onboarding.go`, `backend-go/services/api-gateway/internal/adapter/wscompat/channels_onboarding_test.go`
**Depends on:** none (independent of TASK-027/TASK-028; can land in any order)
**Status:** `[x]` DONE — as specified, including the exact regression test (`TestOnboardingGetPreflightStatus_IsNotLocalPreflightCheck`) proving this channel and `channels.go`'s local `preflight.check` are genuinely distinct handlers. Minor deviation: the test's fixture `ResultJson` was written as compact JSON (no spaces after `:`) rather than the sketch's indented/spaced literal — the sketch's own assertion (`strings.Contains(..., "installed":true)`, no space) would otherwise fail against its own spaced fixture; fixed by tightening the fixture, not the assertion, since the assertion's intent (exact byte round-trip) is the more valuable behavior to pin down. `go build`/`go vet`/`go test -run TestOnboardingGetPreflightStatus` all clean.

---

## Context

BUG-010 flags this as the subtlety most likely to be "fixed" wrong: backend-go already
registers a channel literally named `preflight.check`
(`channels.go:796-818`, quoted verbatim below), but it answers a completely different
question than `onboarding.getPreflightStatus` needs.

| | `preflight.check` (existing, `channels.go:796-818`) | `onboarding.getPreflightStatus` (this task) |
|---|---|---|
| Question | "Can backend-go itself talk to GitHub/GitLab via `gh`/`glab`?" | "What's installed/authenticated on the dev-server **host's OS**?" |
| Answer source | Local, hardcoded — always `gh`/`glab` `installed:false` | Relayed to the agent's real Contract-B `preflight.check` (`agent-rpc-catalog-runtime.md:197`) |
| Why the local answer is correct for its own contract | `scm-integration-service` is a direct OAuth API client, deliberately not a CLI wrapper (`channels.go:805-809`) | Irrelevant here — this asks about the dev-server host's OS-level tool state |

Real current `channels.go:796-818` (verbatim):

```go
func registerPreflightChannels(r *Registry) {
	r.Register("preflight.check", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		return map[string]any{
			"git":  map[string]any{"installed": true},
			"gh":   map[string]any{"installed": false, "authenticated": false},
			"glab": map[string]any{"installed": false, "authenticated": false},
		}, nil
	})
}
```

Wiring `onboarding.getPreflightStatus` by pointing it at this handler (or by calling
`r.Dispatch(ctx, id, "preflight.check", ...)` internally) would be a plausible-looking
but wrong fix — it reports `gh installed:false` forever even on a dev server with `gh`
installed and authenticated. The correct wiring is a NEW relay call to the agent's own
`preflight.check` (same method NAME, different RPC namespace entirely — the agent's,
reached via `RelayByDevServer`, not backend-go's local channel registry).

## Changes to make

### Step 1 — add the handler

Add to `channels_onboarding.go`:

```go
type getPreflightStatusArgs struct {
	DevServerID string `json:"devServerId"`
	Force       bool   `json:"force"` // accepted for wire compatibility; no server-side cache exists to force-bust — see doc comment below
}

// remotePreflightStatusView mirrors frontend/src/shared/dev-server-types.ts:96-118's
// RemotePreflightStatus. gh/glab/git are passed through as raw JSON rather than
// re-typed here: the agent's Contract-B result shape
// (agent-rpc-catalog-runtime.md:197) already matches the frontend's expected
// sub-shape field-for-field, and re-declaring it risks drifting from the agent's
// actual wire contract silently.
type remotePreflightStatusView struct {
	DevServerID string          `json:"devServerId"`
	Platform    string          `json:"platform"`
	CheckedAt   int64           `json:"checkedAt"`
	Gh          json.RawMessage `json:"gh"`
	Glab        json.RawMessage `json:"glab"`
	Git         json.RawMessage `json:"git"`
}

// onboardingGetPreflightStatus relays to the AGENT's own preflight.check
// (Contract B: full gh/glab/git install+auth+identity probe on the dev
// server's host OS) — a DIFFERENT RPC namespace than this file's sibling
// channels.go's local, hardcoded preflight.check (which answers a
// different question: whether backend-go itself can talk to GitHub/GitLab
// via gh/glab — see this task's Context section and BUG-010's own
// emphasis on this exact confusion risk). Do not alias the two.
//
// No server-side cache in this implementation: the old TS backend's
// preflightCache (TASK-022) lived in Electron's single-instance main
// process; backend-go's api-gateway is a shared, multi-connection process,
// so a naive map[devServerId]cachedResult here would leak across tenants
// unless keyed by (tenantID, devServerID), and would need explicit
// invalidation on setGitIdentity to avoid serving a stale "no git
// identity" result right after the user just set one. Given this
// channel's call frequency (onboarding wizard steps, not a hot path),
// this ships without a cache — force is accepted on the wire but
// currently has no effect, since every call already skips straight to a
// fresh relay.
func onboardingGetPreflightStatus(
	ctx context.Context, id Identity, client infrafleetv1.InfraFleetServiceClient, args []json.RawMessage,
) (any, error) {
	in, err := decodeArg[getPreflightStatusArgs](args, 0)
	if err != nil {
		return nil, err
	}
	if in.DevServerID == "" {
		return nil, fmt.Errorf("ONBOARDING_NO_DEV_SERVER: devServerId is required")
	}
	ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID, Role: id.Role})
	rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
	defer cancel()
	resp, err := client.RelayByDevServer(rpcCtx, &infrafleetv1.RelayByDevServerRequest{
		DevServerId: in.DevServerID,
		Method:      "preflight.check", // the AGENT's Contract-B preflight.check — see doc comment above
		ParamsJson:  "{}",
	})
	if err != nil {
		if status.Code(err) == codes.FailedPrecondition {
			return nil, fmt.Errorf("ONBOARDING_DEV_SERVER_NOT_CONNECTED: %s has no live agent session", in.DevServerID)
		}
		return nil, err
	}
	var raw struct {
		Platform string          `json:"platform"`
		Gh       json.RawMessage `json:"gh"`
		Glab     json.RawMessage `json:"glab"`
		Git      json.RawMessage `json:"git"`
	}
	if err := json.Unmarshal([]byte(resp.GetResultJson()), &raw); err != nil {
		return nil, fmt.Errorf("onboarding.getPreflightStatus: decoding relay result: %w", err)
	}
	return remotePreflightStatusView{
		DevServerID: in.DevServerID,
		Platform:    raw.Platform,
		CheckedAt:   time.Now().UnixMilli(),
		Gh:          raw.Gh,
		Glab:        raw.Glab,
		Git:         raw.Git,
	}, nil
}
```

This needs a new `"time"` import in `channels_onboarding.go` — check it isn't already
imported before adding (the current import block, quoted in SOL-010/BUG-010's own
references, does not include it).

Unlike `onboarding.detectAgents`/the TASK-027 relay-copy channels, a disconnected agent
here surfaces as an **error** (`ONBOARDING_DEV_SERVER_NOT_CONNECTED`), not a zero-value
result — there is no honest "nothing detected" fallback for "what's installed on this
host" the way there is for "which agent CLIs did we detect" (an empty list already
means that for `detectAgents`); reporting a fabricated all-`false` status here would be
actively misleading, closer to `devServer.browseDir`'s existing
`NotConnectedErrors`-not-degrades precedent (`channels_test.go:428-446`) than to
`detectAgents`' precedent.

### Step 2 — register the channel

```go
	r.Register("onboarding.getPreflightStatus", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		return onboardingGetPreflightStatus(ctx, id, infraFleetClient, args)
	})
```

### Step 3 — tests, including the specific regression BUG-010 asks for

Add to `channels_onboarding_test.go`:

```go
func TestOnboardingGetPreflightStatus_RelaysToAgentContractB(t *testing.T) {
	var gotMethod string
	fake := &fakeInfraFleetClient{
		relayByDevServerFunc: func(ctx context.Context, in *infrafleetv1.RelayByDevServerRequest) (*infrafleetv1.RelayResponse, error) {
			gotMethod = in.GetMethod()
			return &infrafleetv1.RelayResponse{ResultJson: `{
				"platform": "linux",
				"gh": {"installed": true, "authenticated": true, "login": "octocat"},
				"glab": {"installed": false, "authenticated": false},
				"git": {"installed": true, "identity": {"name": "A", "email": "a@x.com"}}
			}`}, nil
		},
	}
	r := NewRegistry()
	registerOnboardingChannels(r, fake, nil)

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "onboarding.getPreflightStatus",
		argsJSON(t, map[string]any{"devServerId": "ds-1"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if gotMethod != "preflight.check" {
		t.Errorf("want relayed method preflight.check (the AGENT's), got %q", gotMethod)
	}
	view, ok := result.(remotePreflightStatusView)
	if !ok {
		t.Fatalf("unexpected result type %T", result)
	}
	// Proves this channel is NOT silently substituting the local
	// preflight.check handler's hardcoded installed:false answer — the
	// live-relayed gh.installed:true/authenticated:true must round-trip
	// byte-for-byte through the raw json.RawMessage passthrough fields.
	if !strings.Contains(string(view.Gh), `"installed":true`) || !strings.Contains(string(view.Gh), `"authenticated":true`) {
		t.Errorf("want gh installed+authenticated to round-trip from the agent relay, got %s", view.Gh)
	}
	if view.Platform != "linux" {
		t.Errorf("want platform=linux, got %q", view.Platform)
	}
}

// TestOnboardingGetPreflightStatus_IsNotLocalPreflightCheck is the exact
// regression BUG-010 asks for: the two "preflight.check"-named things in
// this codebase (this file's agent-relay handler vs. channels.go's local,
// hardcoded, always-gh-installed-false handler) must be registered as two
// genuinely distinct handler values — this test fails loudly if someone
// "fixes" a future refactor by pointing one at the other.
func TestOnboardingGetPreflightStatus_IsNotLocalPreflightCheck(t *testing.T) {
	fake := &fakeInfraFleetClient{
		relayByDevServerFunc: func(ctx context.Context, in *infrafleetv1.RelayByDevServerRequest) (*infrafleetv1.RelayResponse, error) {
			return &infrafleetv1.RelayResponse{ResultJson: `{"platform":"linux","gh":{"installed":true,"authenticated":true}}`}, nil
		},
	}
	r := NewRegistry()
	registerOnboardingChannels(r, fake, nil)
	registerPreflightChannels(r)

	onboardingResult, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "onboarding.getPreflightStatus",
		argsJSON(t, map[string]any{"devServerId": "ds-1"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	localResult, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "preflight.check", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	onboardingGh := string(onboardingResult.(remotePreflightStatusView).Gh)
	localGh, _ := json.Marshal(localResult.(map[string]any)["gh"])
	if onboardingGh == string(localGh) {
		t.Fatal("onboarding.getPreflightStatus must NOT return the same gh status as the local preflight.check channel — they answer different questions (agent host OS vs. backend-go's own OAuth-vs-CLI design), see this task's Context table")
	}
}

func TestOnboardingGetPreflightStatus_NotConnectedIsAnError(t *testing.T) {
	fake := &fakeInfraFleetClient{
		relayByDevServerFunc: func(ctx context.Context, in *infrafleetv1.RelayByDevServerRequest) (*infrafleetv1.RelayResponse, error) {
			return nil, status.Error(codes.FailedPrecondition, "not connected")
		},
	}
	r := NewRegistry()
	registerOnboardingChannels(r, fake, nil)

	_, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "onboarding.getPreflightStatus",
		argsJSON(t, map[string]any{"devServerId": "ds-1"}))
	if err == nil {
		t.Fatal("want an error — unlike detectAgents, there is no honest zero-value fallback for 'what's installed on this host'")
	}
}
```

`strings` needs importing in the test file if not already present.

## Verify

```bash
cd backend-go
go build ./services/api-gateway/...
go vet ./services/api-gateway/...
go test ./services/api-gateway/internal/adapter/wscompat/... -run TestOnboardingGetPreflightStatus -v -count=1
```
