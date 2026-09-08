# SOL-010: Wire 4 `onboarding.*` methods as pure relay copies of `detectAgents`, add a fan-out loop for the 5th, flag `openGhAuthTerminal` as blocked on `terminal.create`

**Resolves:** [BUG-010](../BUG-010-onboarding-preflight-channels-not-implemented.md)
**Service:** `api-gateway` (WS compat layer) — no new proto RPC, no new usecase; every relayed method already exists on the Dev Server Agent
**Affected files (proposed):**
- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_onboarding.go` (extend `registerOnboardingChannels`, add 5 new handlers)
- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_onboarding_test.go` (extend)
**Status:** 🚧 Proposed — no code written

---

## Design principle: copy `onboardingDetectAgents`'s skeleton, don't invent a new one

`onboardingDetectAgents` (`channels_onboarding.go:254-316`) already establishes the exact shape every
"ask the agent something host-local" onboarding method needs:

1. Decode `devServerId` (+ any op-specific args) from `args[0]`.
2. Reject an empty `devServerId` with a clear `ONBOARDING_NO_DEV_SERVER`-style error.
3. `gatewaygrpc.AttachIdentity` + `context.WithTimeout(ctx, rpcTimeout)`.
4. `client.RelayByDevServer(rpcCtx, &infrafleetv1.RelayByDevServerRequest{DevServerId: ..., Method: "preflight.<x>", ParamsJson: ...})`.
5. On `codes.FailedPrecondition` (no live agent session), return an honest empty/zero result rather than an
   error — "agent not connected yet" is a normal onboarding state, not a failure.
6. Otherwise unmarshal `resp.GetResultJson()` into the typed result and return it.

Four of the five new channels below are this skeleton verbatim, with only the relayed method name and the
result-shape struct changed. This is deliberately not novel design — BUG-010 already did the hard part
(confirming each agent RPC exists) and the fix is copy-and-rename.

---

## `onboarding.detectWindowsCapabilities`, `onboarding.detectGhosttyConfig`, `onboarding.setGitIdentity` — verbatim copies

Agent RPCs confirmed to already exist and be implemented on **both** connection types (Part A direct-websocket
and Part B) per `specs/agent/api/agent-rpc-catalog-runtime.md:191-199`'s parity table — so no `agent/` work is
needed for any of these three:

```go
// channels_onboarding.go — add to registerOnboardingChannels

r.Register("onboarding.detectWindowsCapabilities", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
	return relayOnboardingDevServerOp[windowsTerminalCapabilitiesView](ctx, id, infraFleetClient, args, "preflight.detectWindowsTerminalCapabilities")
})

r.Register("onboarding.detectGhosttyConfig", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
	return relayOnboardingDevServerOp[ghosttyConfigView](ctx, id, infraFleetClient, args, "preflight.detectGhosttyConfig")
})

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
	// setGitIdentity's frontend contract is void/Promise<void> (runtime-onboarding-client.ts:85-95)
	// — unlike the read-only detect* methods, "agent not connected" here is a genuine failure to
	// surface (there is nothing useful to fall back to), so FailedPrecondition is NOT swallowed.
	return nil, err
})
```

```go
// generic relay-and-decode helper shared by the 3 read-only ops above —
// mirrors onboardingDetectAgents' FailedPrecondition-tolerant shape but
// parameterized over the (zero-arg) result type, since none of these 3
// take op-specific params beyond devServerId.
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
		if status.Code(err) == codes.FailedPrecondition {
			return zero, nil // honest "nothing detected yet" — see onboardingDetectAgents' own precedent
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

type onboardingDevServerArgs struct {
	DevServerID string `json:"devServerId"`
}

type setGitIdentityArgs struct {
	DevServerID string `json:"devServerId"`
	Name        string `json:"name"`
	Email       string `json:"email"`
}

// windowsTerminalCapabilitiesView mirrors frontend/src/shared/dev-server-types.ts:137-146.
type windowsTerminalCapabilitiesView struct {
	WslAvailable    bool     `json:"wslAvailable"`
	WslDistros      []string `json:"wslDistros"`
	PwshAvailable   bool     `json:"pwshAvailable"`
	PwshVersion     *string  `json:"pwshVersion"`
	GitBashAvailable bool    `json:"gitBashAvailable"`
	GitBashPath     *string  `json:"gitBashPath"`
	HostPlatform    *string  `json:"hostPlatform"`
}

// ghosttyConfigView mirrors runtime-onboarding-client.ts:97-106's return type.
type ghosttyConfigView struct {
	ConfigPath *string `json:"configPath"`
	ThemeDir   *string `json:"themeDir"`
}
```

`WslDistros` is a plain `[]string` field on a non-proto value struct returned through `Registry.Dispatch`, so
`normalizeNilSlices` (`registry.go:219-238`) already guarantees it serializes as `[]`, not `null`, on the
"nothing detected" path — no extra handling needed here.

---

## `onboarding.detectAgentsAllServers` — a fan-out loop, still zero new proto RPCs

Per BUG-010, this is not a single agent RPC — it's the old TS backend's `detectAgentsAllDevServers`
(`desktop/src/main/ipc/onboarding-ipc.ts:111-141`) fan-out: enumerate every dev server the caller can see,
call the same per-server relay `onboardingDetectAgents` already does, once per server, merge into a
`Record<devServerId, {agents, platform, error?}>`.

The caller-visible dev-server set already has a backend-go answer: `infra-fleet-service.ListDevServersForUser`
is the exact RPC `devServer.listForUser` uses to enumerate "dev servers this user can see"
(`channels_dev_server_access_control.go:275-306`) — reusing it here means `detectAgentsAllServers` sees the
same server set the user's own dev-server picker does, not a separate/inconsistent notion of "all servers."

```go
// channels_onboarding.go

r.Register("onboarding.detectAgentsAllServers", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
	return onboardingDetectAgentsAllServers(ctx, id, infraFleetClient, tenantClient, args)
})

type onboardingDetectAgentsAllServersResult struct {
	Agents   []string `json:"agents"`
	Platform *string  `json:"platform"`
	Error    *string  `json:"error,omitempty"`
}

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
		perServerArgs, _ := json.Marshal(onboardingDetectAgentsArgs{DevServerID: devServerID, Commands: in.Commands})
		result, err := onboardingDetectAgents(ctx, id, fleetClient, []json.RawMessage{perServerArgs})
		if err != nil {
			errStr := err.Error()
			out[devServerID] = onboardingDetectAgentsAllServersResult{Agents: []string{}, Error: &errStr}
			continue
		}
		typed := result.(onboardingDetectAgentsResult)
		out[devServerID] = onboardingDetectAgentsAllServersResult{Agents: typed.Agents, Platform: typed.Platform}
	}
	return out, nil
}
```

Two deliberate departures from the old TS backend's version, both narrowing scope rather than widening it:

- **No client-side 60s cache** (`getCachedDetection` in the old handler) — `onboardingDetectAgents` has none
  either today, and adding one only to this fan-out would make single-server and all-server detection
  inconsistent for no clear benefit; can be added to both uniformly later if agent-detection latency turns
  out to matter in practice.
- **No pre-filter to "connected" dev servers only** (the old handler's `.filter((ds) => ds.status ===
  'connected')`) — `onboardingDetectAgents`'s own `FailedPrecondition` handling already answers "not
  connected" as an empty-agents result per server, so the filter would only save an RPC round trip, not
  change correctness; kept out to keep this handler a pure composition of two already-tested primitives
  (`ListDevServersForUser`, `onboardingDetectAgents`) rather than adding its own connectivity-state logic.

---

## `onboarding.getPreflightStatus` — the one that must NOT reuse the existing local `preflight.check`

This is the subtlety BUG-010 flags most emphatically, worth restating precisely: **backend-go already
registers a channel named `preflight.check`** (`channels.go:796-818`), but it answers a different question
than what `onboarding.getPreflightStatus` needs.

| | `preflight.check` (`channels.go:796-818`, existing) | `onboarding.getPreflightStatus` (this proposal) |
|---|---|---|
| Question | "Can backend-go itself talk to GitHub/GitLab via `gh`/`glab`?" | "What's installed/authenticated on **the dev-server host's OS**?" |
| Answer source | Local, hardcoded — always `gh`/`glab` `installed:false` | Relayed to the agent's real Contract-B `preflight.check` (`agent-rpc-catalog-runtime.md:197`, "Full gh/glab/git install+auth+identity check") |
| Why the local answer is correct for its own contract | `scm-integration-service` is a direct OAuth API client, deliberately not a CLI wrapper (`channels.go:805-809`) | Irrelevant here — this is asking about the dev-server host's OS-level tool state, independent of backend-go's own GitHub API access strategy |

Wiring `onboarding.getPreflightStatus` by pointing it at the existing `preflight.check` handler would be a
plausible-looking but wrong fix — it would report `gh installed:false` forever even on a dev server with `gh`
installed and authenticated, silently breaking the onboarding wizard's actual purpose (helping the user finish
setting up their **dev server**, not backend-go's own credential story). The correct wiring relays instead:

```go
// channels_onboarding.go

r.Register("onboarding.getPreflightStatus", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
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
	resp, err := infraFleetClient.RelayByDevServer(rpcCtx, &infrafleetv1.RelayByDevServerRequest{
		DevServerId: in.DevServerID,
		Method:      "preflight.check", // the AGENT's Contract-B preflight.check — a different RPC namespace than
		ParamsJson:  "{}",              // this file's own local preflight.check channel; see table above
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
})

type getPreflightStatusArgs struct {
	DevServerID string `json:"devServerId"`
	Force       bool   `json:"force"` // no server-side cache in this proposal — see note below
}

// remotePreflightStatusView mirrors frontend/src/shared/dev-server-types.ts:96-118's RemotePreflightStatus.
// gh/glab/git are passed through as raw JSON rather than re-typed here: the agent's Contract-B result shape
// (agent-rpc-catalog-runtime.md:197) already matches the frontend's expected sub-shape field-for-field, and
// re-declaring it risks drifting from the agent's actual wire contract silently.
type remotePreflightStatusView struct {
	DevServerID string          `json:"devServerId"`
	Platform    string          `json:"platform"`
	CheckedAt   int64           `json:"checkedAt"`
	Gh          json.RawMessage `json:"gh"`
	Glab        json.RawMessage `json:"glab"`
	Git         json.RawMessage `json:"git"`
}
```

**No server-side 30s cache in this proposal.** The old TS backend's `preflightCache` (TASK-022) lived in the
Electron main process's memory, scoped to that one desktop instance. backend-go's `api-gateway` is a shared,
multi-connection process — a naive `map[devServerId]cachedResult` here would leak across tenants unless keyed
by `(tenantID, devServerID)`, and would need explicit invalidation on `setGitIdentity` (TASK-022's handler
does this: `preflightCache.delete(params.devServerId)`) to avoid serving a stale "no git identity" result
right after the user just set one. Given `getPreflightStatus`'s call frequency (onboarding wizard steps, not
a hot path) and severity (Medium, per BUG-010's own header), this proposal ships without a cache — `force` is
accepted on the wire for frontend compatibility but currently has no effect, since every call already skips
straight to a fresh relay. Revisit if the wizard is observed hammering this channel in practice.

---

## `onboarding.openGhAuthTerminal` — blocked on `terminal.create`, not designed here

Per BUG-010's own finding (`TASK-022:91-105`), this needs to spawn a PTY on the dev server running
`gh auth login` and return a `ptyId` the frontend attaches a terminal pane to. There is no PTY-creation
primitive in backend-go's `wscompat` layer to build this on today — `terminal.create` itself is unregistered
(a separate `missing-v3` finding, assigned to a parallel agent's `SOL-008` in this same investigation pass).

This proposal deliberately does **not** attempt to design around that gap (e.g. by inventing a
one-off PTY-spawn path specific to `gh auth login`) — that would create two divergent PTY-creation code paths
in `wscompat` for no good reason, one of which (`terminal.create` itself) is already being designed elsewhere.
Once `terminal.create` lands, `onboarding.openGhAuthTerminal` becomes a thin wrapper:

```go
// Sketch only — depends on terminal.create's actual signature, not designed here.
r.Register("onboarding.openGhAuthTerminal", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
	in, err := decodeArg[onboardingDevServerArgs](args, 0)
	if err != nil {
		return nil, err
	}
	// Delegates to whatever terminal.create's internal Go entry point turns out to be,
	// with command="gh", args=["auth","login"] — see SOL-008 (parallel agent) for that shape.
	return nil, fmt.Errorf("ONBOARDING_BLOCKED_ON_TERMINAL_CREATE: openGhAuthTerminal needs terminal.create, not yet implemented")
})
```

Left unregistered (falling through to `notImplementedHandler`) is equally honest and simpler; the sketch
above is included only to make the dependency concrete for whoever picks up `terminal.create` next, not as
something to ship standalone.

---

## Test plan

- `channels_onboarding_test.go`:
  - One table-driven test per relay-copy channel (`detectWindowsCapabilities`, `detectGhosttyConfig`,
    `setGitIdentity`) against a fake `InfraFleetServiceClient`: asserts the relayed `Method` string, asserts
    `FailedPrecondition` degrades to a zero-value result for the two read-only ones and propagates as an error
    for `setGitIdentity`, asserts a missing `devServerId` fails fast without calling `RelayByDevServer`.
  - `detectAgentsAllServers`: fake `ListDevServersForUser` returning 3 dev servers, fake
    `RelayByDevServer` returning success for 2 and `FailedPrecondition`/an arbitrary error for the third —
    assert the result map has exactly 3 keys, the failing one carries a non-nil `error` and an empty (not
    nil) `agents` slice.
  - `getPreflightStatus`: fake relay returning a Contract-B-shaped JSON payload — assert the returned
    `remotePreflightStatusView.Gh`/`.Glab`/`.Git` round-trip byte-for-byte (proves this channel is NOT
    silently substituting the local `preflight.check` handler's hardcoded `installed:false` answer). A
    regression test asserting `onboarding.getPreflightStatus`'s registered handler is a distinct function
    value from `preflight.check`'s is worth adding given how easy this specific mistake would be to make.
  - `openGhAuthTerminal`: left unregistered — assert `Registry.Dispatch` falls through to
    `notImplementedHandler` for this channel today (documents the intentional gap, fails loudly if someone
    half-wires it without `terminal.create`).

## References

- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_onboarding.go:156-235,254-316` — the `detectAgents` relay pattern this proposal copies 4 times
- `backend-go/services/api-gateway/internal/adapter/wscompat/channels.go:796-818` — the existing, DIFFERENT-CONTRACT local `preflight.check` this proposal must not be confused with
- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_dev_server_access_control.go:275-306` — `devServer.listForUser`'s `GetUserProfile` → `ListDevServersForUser` pattern, reused for the fan-out's dev-server enumeration
- `backend-go/services/api-gateway/internal/adapter/wscompat/registry.go:219-238` — `normalizeNilSlices`, why `WslDistros`/`Agents` don't need manual `[]string{}` fallback handling
- `specs/agent/api/agent-rpc-catalog-runtime.md:176-205` — agent-side `preflight.*` parity table (Part A/B), the ground truth for which agent RPCs already exist
- `specs/backend/crs/v1/onboarding/tasks/TASK-022-onboarding-ipc-preflight-handlers.md` — old TS backend's reference shape for all 4 Phase-2 handlers, including the cache-invalidation-on-setGitIdentity behavior this proposal explicitly chooses not to replicate yet
- `desktop/src/main/ipc/onboarding-ipc.ts:70-141` — `detectAgentsForDevServer`/`detectAgentsAllDevServers`'s exact fan-out and cache semantics (desktop-local precedent)
- `frontend/src/renderer/src/runtime/runtime-onboarding-client.ts:53-128` — all 6 call sites this proposal answers (5 designed, 1 flagged blocked)
- `frontend/src/shared/dev-server-types.ts:96-146` — `RemotePreflightStatus`/`WindowsTerminalCapabilities` result shapes this proposal's view structs mirror
- `specs/backend-go/bugs/missing-v3/BUG-010-onboarding-preflight-channels-not-implemented.md` — the bug this resolves, including the `terminal.create` dependency this proposal does not attempt to design around
