// ── onboarding.* ─────────────────────────────────────────────────────────
//
// The old TS backend's onboarding.get (backend/src/main/runtime/rpc/methods/
// onboarding.ts, backed by persistence.ts's Store.getOnboarding()) is purely
// local, per-installation wizard-progress UI state (frontend/src/shared/
// types.ts's OnboardingState/OnboardingChecklistState) — which step of the
// first-run wizard the user finished, which checklist items they've hit.
// It is NOT derived from any tenant/user/project existence check (that's a
// different concept: auth-service's bootstrap.go, which seeds the first
// admin and is deliberately not exposed over any RPC).
//
// Live bug (user-reported): onboarding.get/update never persisted anything
// — every page reload re-showed the onboarding wizard forever, since the
// only state that ever existed was echoed back from the caller's own
// partial update, in memory, for the life of one request. Fixed by
// persisting through tenant-service's GetOnboardingState/SetOnboardingState
// (backed by a new tenant.user_profiles.onboarding_state_json column) — see
// that RPC pair's doc comment in tenant.proto for why this is a dedicated
// per-user store rather than folded into profile settings_json.
package wscompat

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	infrafleetv1 "github.com/stablyai/orca-go/proto/gen/go/orca/infrafleet/v1"
	tenantv1 "github.com/stablyai/orca-go/proto/gen/go/orca/tenant/v1"

	gatewaygrpc "github.com/stablyai/orca-go/services/api-gateway/internal/adapter/grpc"
	"github.com/stablyai/orca-go/services/api-gateway/internal/usecase"
)

// onboardingFlowVersion mirrors frontend/src/shared/constants.ts's
// ONBOARDING_FLOW_VERSION — bump together if the frontend's wizard step
// numbering ever changes.
const onboardingFlowVersion = 4

type onboardingChecklistView struct {
	AddedRepo                bool `json:"addedRepo"`
	ChoseAgent               bool `json:"choseAgent"`
	RanFirstAgent            bool `json:"ranFirstAgent"`
	RanSecondAgentOnSameTask bool `json:"ranSecondAgentOnSameTask"`
	TriedCmdJ                bool `json:"triedCmdJ"`
	ShapedSidebar            bool `json:"shapedSidebar"`
	ReviewedDiff             bool `json:"reviewedDiff"`
	OpenedPr                 bool `json:"openedPr"`
	AddedFolder              bool `json:"addedFolder"`
	OpenedFile               bool `json:"openedFile"`
	RanAgentOnFile           bool `json:"ranAgentOnFile"`
	Dismissed                bool `json:"dismissed"`
}

// set assigns value to the named checklist field — a plain switch rather
// than reflection, matching this codebase's preference for explicit code
// (see e.g. adminUserRoleWire) over magic for a small, fixed field set.
// Unknown item names are ignored (forward-compatible with a frontend built
// against a newer checklist than this binary knows about, rather than
// erroring the whole markChecklistItem call).
func (c *onboardingChecklistView) set(item string, value bool) {
	switch item {
	case "addedRepo":
		c.AddedRepo = value
	case "choseAgent":
		c.ChoseAgent = value
	case "ranFirstAgent":
		c.RanFirstAgent = value
	case "ranSecondAgentOnSameTask":
		c.RanSecondAgentOnSameTask = value
	case "triedCmdJ":
		c.TriedCmdJ = value
	case "shapedSidebar":
		c.ShapedSidebar = value
	case "reviewedDiff":
		c.ReviewedDiff = value
	case "openedPr":
		c.OpenedPr = value
	case "addedFolder":
		c.AddedFolder = value
	case "openedFile":
		c.OpenedFile = value
	case "ranAgentOnFile":
		c.RanAgentOnFile = value
	case "dismissed":
		c.Dismissed = value
	}
}

type onboardingStateView struct {
	FlowVersion       int                     `json:"flowVersion"`
	ClosedAt          *int64                  `json:"closedAt"`
	Outcome           *string                 `json:"outcome"`
	LastCompletedStep int                     `json:"lastCompletedStep"`
	Checklist         onboardingChecklistView `json:"checklist"`
}

func defaultOnboardingStateView() onboardingStateView {
	return onboardingStateView{
		FlowVersion:       onboardingFlowVersion,
		ClosedAt:          nil,
		Outcome:           nil,
		LastCompletedStep: -1, // sentinel: wizard not started, matches getDefaultOnboardingState()
		Checklist:         onboardingChecklistView{},
	}
}

// loadOnboardingState fetches userID's persisted state, falling back to
// defaults on any failure (no state saved yet, transient RPC error, or a
// caller with no resolved user id) — persistence is a nice-to-have for this
// channel family; a hiccup here must never block the onboarding UI itself
// the way it did before this was wired up at all.
func loadOnboardingState(ctx context.Context, id Identity, client tenantv1.TenantServiceClient) onboardingStateView {
	fallback := defaultOnboardingStateView()
	if client == nil || id.UserID == "" {
		return fallback
	}
	ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID, Role: id.Role})
	rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
	defer cancel()
	resp, err := client.GetOnboardingState(rpcCtx, &tenantv1.GetOnboardingStateRequest{UserId: id.UserID})
	if err != nil || !resp.GetFound() || resp.GetStateJson() == "" {
		return fallback
	}
	var state onboardingStateView
	if err := json.Unmarshal([]byte(resp.GetStateJson()), &state); err != nil {
		return fallback
	}
	return state
}

// saveOnboardingState persists state for userID — same fail-open contract
// as loadOnboardingState's doc comment: a save failure is swallowed (not
// surfaced as a channel error) so a transient tenant-service hiccup never
// blocks the caller from advancing/closing the wizard, matching this
// channel's pre-persistence behavior when nothing could be saved at all.
func saveOnboardingState(ctx context.Context, id Identity, client tenantv1.TenantServiceClient, state onboardingStateView) {
	if client == nil || id.UserID == "" {
		return
	}
	stateJSON, err := json.Marshal(state)
	if err != nil {
		return
	}
	ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID, Role: id.Role})
	rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
	defer cancel()
	_, _ = client.SetOnboardingState(rpcCtx, &tenantv1.SetOnboardingStateRequest{
		UserId:    id.UserID,
		StateJson: string(stateJSON),
	})
}

func registerOnboardingChannels(
	r *Registry,
	infraFleetClient infrafleetv1.InfraFleetServiceClient,
	tenantClient tenantv1.TenantServiceClient,
) {
	r.Register("onboarding.get", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		return loadOnboardingState(ctx, id, tenantClient), nil
	})

	// onboarding.update — frontend/src/renderer/src/components/onboarding/
	// use-onboarding-flow-persistence.ts's closeWith() awaits this on every
	// Skip/Continue-to-completion action and only proceeds (closes the
	// modal) if it resolves. Merges the caller's partial update onto the
	// PERSISTED current state (not bare defaults — see loadOnboardingState)
	// and saves the result, so a reload sees the same progress instead of
	// re-showing the wizard from scratch.
	r.Register("onboarding.update", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		in, err := decodeArg[onboardingUpdateArgs](args, 0)
		if err != nil {
			return nil, err
		}

		out := loadOnboardingState(ctx, id, tenantClient)
		if in.FlowVersion != nil {
			out.FlowVersion = *in.FlowVersion
		}
		if in.ClosedAt != nil {
			out.ClosedAt = in.ClosedAt
		}
		if in.Outcome != nil {
			out.Outcome = in.Outcome
		}
		if in.LastCompletedStep != nil {
			out.LastCompletedStep = *in.LastCompletedStep
		}
		if in.Checklist != nil {
			out.Checklist = *in.Checklist
		}
		saveOnboardingState(ctx, id, tenantClient, out)
		return out, nil
	})

	// onboarding.markChecklistItem — same persist-on-top-of-current-state
	// pattern as onboarding.update, for the one-field-at-a-time checklist
	// mark path (frontend calls this instead of a full onboarding.update
	// for individual product-moment tracking, e.g. "ran first agent").
	r.Register("onboarding.markChecklistItem", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type markArgs struct {
			Item  string `json:"item"`
			Value *bool  `json:"value"`
		}
		in, err := decodeArg[markArgs](args, 0)
		if err != nil {
			return nil, err
		}
		value := true
		if in.Value != nil {
			value = *in.Value
		}
		state := loadOnboardingState(ctx, id, tenantClient)
		state.Checklist.set(in.Item, value)
		saveOnboardingState(ctx, id, tenantClient, state)
		return map[string]any{"marked": true}, nil
	})

	// onboarding.detectAgents — the web build has no paired Electron desktop
	// app, so preflight.detectAgents (a local-PATH-only concept, see
	// channels_dev_server_access_control.go's connection-oriented siblings)
	// can never answer "which agent CLIs are installed" for a browser
	// session. The real question for a dev-server-agent connection is "what's
	// on THAT host's PATH" — answered by relaying the agent's own confirmed
	// preflight.detectAgents RPC (specs/agent/api/agent-rpc-catalog-runtime.md)
	// through the same resolve-devServerId-then-Relay path
	// registerAccountsResolveDevServerConnectionChannel/registerAccountsRelay
	// (channels_accounts.go) already established — no new infra-fleet-service
	// RPC needed.
	r.Register("onboarding.detectAgents", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		return onboardingDetectAgents(ctx, id, infraFleetClient, args)
	})

	r.Register("onboarding.detectAgentsAllServers", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		return onboardingDetectAgentsAllServers(ctx, id, infraFleetClient, tenantClient, args)
	})

	r.Register("onboarding.getPreflightStatus", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		return onboardingGetPreflightStatus(ctx, id, infraFleetClient, args)
	})

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

	registerOnboardingOpenGhAuthTerminalChannel(r, infraFleetClient)
}

// onboardingDevServerArgs is the {devServerId} wire shape shared by every
// onboarding.* channel below that takes no other parameter.
type onboardingDevServerArgs struct {
	DevServerID string `json:"devServerId"`
}

// setGitIdentityArgs mirrors onboarding.setGitIdentity's wire shape.
type setGitIdentityArgs struct {
	DevServerID string `json:"devServerId"`
	Name        string `json:"name"`
	Email       string `json:"email"`
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

type onboardingDetectAgentsAllServersResult struct {
	Agents   []string `json:"agents"`
	Platform *string  `json:"platform"`
	Error    *string  `json:"error,omitempty"`
}

// onboardingDetectAgentsAllServers fans onboardingDetectAgents out across
// every dev server the caller can see (via the same GetUserProfile ->
// ListDevServersForUser path devServer.listForUser uses,
// channels_dev_server_access_control.go), merging results keyed by
// devServerId — the backend-go equivalent of the old TS backend's
// detectAgentsAllDevServers (desktop/src/main/ipc/onboarding-ipc.ts:111-141).
//
// Deviation from TASK-028's original sketch: also resolves and passes
// TeamIds (via tenant-service.ListTeamsForUser), not just DepartmentId —
// devServer.listForUser (this same package) was fixed under BUG-013 to
// include team-granted dev servers too; omitting TeamIds here would make
// this fan-out see a narrower dev-server set than the caller's own
// devServer.listForUser view, an inconsistency with no upside.
//
// Deliberately narrower than the old handler in two other ways, both
// scope-only (see SOL-010 for the full reasoning): no client-side 60s
// detection cache (onboardingDetectAgents itself has none either, so adding
// one only here would make single-server and all-server detection
// inconsistent), and no pre-filter to "connected" dev servers only
// (onboardingDetectAgents' existing FailedPrecondition handling already
// answers "not connected" as an empty-agents result per server, so a
// filter would only save an RPC round trip, not change correctness).
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

	teamsCtx, teamsCancel := context.WithTimeout(gwCtx, rpcTimeout)
	defer teamsCancel()
	teamsResp, err := tenantClient.ListTeamsForUser(teamsCtx, &tenantv1.ListTeamsForUserRequest{UserId: id.UserID})
	if err != nil {
		return nil, err
	}

	listCtx, listCancel := context.WithTimeout(gwCtx, rpcTimeout)
	defer listCancel()
	listResp, err := fleetClient.ListDevServersForUser(listCtx, &infrafleetv1.ListDevServersForUserRequest{
		DepartmentId: profileResp.GetProfile().GetDepartmentId(),
		TeamIds:      teamsResp.GetTeamIds(),
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
// via gh/glab — see BUG-010's own emphasis on this exact confusion risk).
// Do not alias the two.
//
// No server-side cache in this implementation: the old TS backend's
// preflightCache lived in Electron's single-instance main process;
// backend-go's api-gateway is a shared, multi-connection process, so a
// naive map[devServerId]cachedResult here would leak across tenants unless
// keyed by (tenantID, devServerID), and would need explicit invalidation on
// setGitIdentity to avoid serving a stale "no git identity" result right
// after the user just set one. Given this channel's call frequency
// (onboarding wizard steps, not a hot path), this ships without a cache —
// force is accepted on the wire but currently has no effect, since every
// call already skips straight to a fresh relay.
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

// onboardingDetectAgentsArgs' commands mirrors desktop's
// AgentDetectionCommand[] (desktop/src/shared/agent-detection-commands.ts) /
// frontend's TuiAgentDetectionCommand[] — built client-side from
// TUI_AGENT_CONFIG (the single source of truth for the agent catalog) and
// passed through verbatim, so this service does not need its own copy of
// the catalog.
type onboardingDetectAgentsArgs struct {
	DevServerID string           `json:"devServerId"`
	Commands    []map[string]any `json:"commands"`
}

type onboardingDetectAgentsResult struct {
	Agents      []string `json:"agents"`
	Platform    *string  `json:"platform"`
	DevServerID string   `json:"devServerId"`
}

func onboardingDetectAgents(
	ctx context.Context,
	id Identity,
	client infrafleetv1.InfraFleetServiceClient,
	args []json.RawMessage,
) (any, error) {
	in, err := decodeArg[onboardingDetectAgentsArgs](args, 0)
	if err != nil {
		return nil, err
	}
	if in.DevServerID == "" {
		return nil, fmt.Errorf("ONBOARDING_NO_DEV_SERVER: devServerId is required")
	}

	ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID, Role: id.Role})
	rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
	defer cancel()

	paramsJSON, err := json.Marshal(map[string]any{"commands": in.Commands})
	if err != nil {
		return nil, err
	}
	// Why RelayByDevServer, not ResolveConnection+Relay: ResolveConnection
	// answers "is there an infra.connections row for this dev server", a
	// different concept from "is the agent's session live" (see
	// usecase.RelayByDevServer's doc comment) — a dev server has no
	// connections row until a repo/worktree is bound to it, which hasn't
	// happened yet during onboarding's agent-detection step.
	resp, err := client.RelayByDevServer(rpcCtx, &infrafleetv1.RelayByDevServerRequest{
		DevServerId: in.DevServerID,
		Method:      "preflight.detectAgents",
		ParamsJson:  string(paramsJSON),
	})
	if err != nil {
		// Why: "no live connection right now" is a legitimate onboarding
		// state (agent not connected yet), not an error — mirrors
		// registerAccountsResolveDevServerConnectionChannel's same
		// tolerance. Any OTHER error (e.g. an unknown devServerId) still
		// propagates.
		if status.Code(err) == codes.FailedPrecondition {
			return onboardingDetectAgentsResult{Agents: []string{}, DevServerID: in.DevServerID}, nil
		}
		return nil, err
	}

	var relayResult struct {
		Agents   []string `json:"agents"`
		Platform *string  `json:"platform"`
	}
	if raw := resp.GetResultJson(); raw != "" {
		if err := json.Unmarshal([]byte(raw), &relayResult); err != nil {
			return nil, fmt.Errorf("onboarding.detectAgents: decoding relay result: %w", err)
		}
	}
	if relayResult.Agents == nil {
		relayResult.Agents = []string{}
	}
	return onboardingDetectAgentsResult{
		Agents:      relayResult.Agents,
		Platform:    relayResult.Platform,
		DevServerID: in.DevServerID,
	}, nil
}

// onboardingOpenGhAuthTerminalResultView mirrors
// frontend/src/preload/api-types.ts's openGhAuthTerminal return shape
// ({ ptyId, devServerId }) — the frontend attaches a terminal pane to ptyId
// via the same terminal.subscribe/terminal.output machinery any other
// terminal.create'd pty uses; it does not need a separate result shape.
type onboardingOpenGhAuthTerminalResultView struct {
	PtyID       string `json:"ptyId"`
	DevServerID string `json:"devServerId"`
}

// registerOnboardingOpenGhAuthTerminalChannel wires onboarding.openGhAuthTerminal
// — spawns a PTY on the caller's dev server and types "gh auth login" into
// it, mirroring registerTerminalCreateChannel's own
// spawn-then-AttachPty-then-register pattern (channels_terminal.go) almost
// exactly. Two differences from terminal.create:
//
//  1. The caller supplies a devServerId, not a connectionId — this channel
//     resolves it via ResolveConnection(dev_server_id=...) first (the same
//     alternate-key path channels_browser.go's worktree-keyed lookups and
//     ai-provider-service's TestConnection already use for the OTHER two
//     ResolveConnectionRequest keys), so no new resolution primitive is
//     needed. A resolved-but-disconnected dev server is a normal "come back
//     later" onboarding state, not a crash — surfaced as
//     ONBOARDING_DEV_SERVER_NOT_CONNECTED, the same convention
//     onboardingGetPreflightStatus already uses.
//  2. Once the pty exists, this channel immediately types "gh auth login\n"
//     into it as terminal input (exactly what registerTerminalSendChannel
//     does for a normal terminal.send) — the agent's pty.create RPC only
//     supports {cwd, cols, rows, env, shellOverride}, no direct command+args
//     (agent-rpc-dispatch-pty.ts), so running a specific command means
//     spawning a plain shell and typing into it like a real user would.
//
// Registered via RegisterStreamChannel, not Register: like terminal.create,
// its invoke must both ack with {ptyId, devServerId} AND open the live
// AttachPty subscription that keeps delivering terminal.output/
// terminal.exited push frames for the rest of the pty's life.
func registerOnboardingOpenGhAuthTerminalChannel(r *Registry, client infrafleetv1.InfraFleetServiceClient) {
	r.RegisterStreamChannel("onboarding.openGhAuthTerminal", func(ctx context.Context, id Identity, args []json.RawMessage) (any, <-chan PushEvent, error) {
		in, err := decodeArg[onboardingDevServerArgs](args, 0)
		if err != nil {
			return nil, nil, err
		}
		if in.DevServerID == "" {
			return nil, nil, fmt.Errorf("ONBOARDING_NO_DEV_SERVER: devServerId is required")
		}
		streams := terminalStreamsFromContext(ctx)
		if streams == nil {
			return nil, nil, errNoTerminalStreamRegistry
		}

		invokeCtx := gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID, Role: id.Role})
		resolved, err := client.ResolveConnection(invokeCtx, &infrafleetv1.ResolveConnectionRequest{DevServerId: in.DevServerID})
		if err != nil {
			return nil, nil, err
		}
		if !resolved.GetConnected() {
			return nil, nil, fmt.Errorf("ONBOARDING_DEV_SERVER_NOT_CONNECTED: %s has no live agent session", in.DevServerID)
		}

		spawnResp, err := client.SpawnTerminalSession(invokeCtx, &infrafleetv1.SpawnTerminalSessionRequest{
			ConnectionId: resolved.GetConnectionId(),
		})
		if err != nil {
			return nil, nil, err
		}
		session := spawnResp.GetSession()

		// See attachContext's doc comment (channels_terminal.go): the stream
		// MUST outlive this invoke's own 25s deadline.
		streamCtx, cancel := attachContext(id)
		stream, err := client.AttachPty(streamCtx)
		if err != nil {
			cancel()
			return nil, nil, fmt.Errorf("wscompat: opening AttachPty stream for onboarding gh-auth pty %q: %w", session.GetPtyId(), err)
		}
		if err := stream.Send(&infrafleetv1.PtyClientFrame{
			Frame: &infrafleetv1.PtyClientFrame_Attach{Attach: &infrafleetv1.AttachToSession{PtyId: session.GetPtyId()}},
		}); err != nil {
			cancel()
			return nil, nil, fmt.Errorf("wscompat: sending AttachPty's initial attach frame for onboarding gh-auth pty %q: %w", session.GetPtyId(), err)
		}

		entry := &terminalStreamEntry{stream: stream, cancel: cancel}
		streams.put(session.GetPtyId(), entry)

		events := make(chan PushEvent)
		go drainAttachPtyOutput(streamCtx, session.GetPtyId(), entry, streams, events)

		// Type the command in — see this function's doc comment, point 2.
		if err := entry.send(&infrafleetv1.PtyClientFrame{
			Frame: &infrafleetv1.PtyClientFrame_Input{Input: &infrafleetv1.PtyInput{Data: []byte("gh auth login\n")}},
		}); err != nil {
			cancel() // drainAttachPtyOutput's own cleanup removes the registry entry once Recv observes the cancellation
			return nil, nil, fmt.Errorf("wscompat: sending initial 'gh auth login' input for pty %q: %w", session.GetPtyId(), err)
		}

		return onboardingOpenGhAuthTerminalResultView{PtyID: session.GetPtyId(), DevServerID: in.DevServerID}, events, nil
	})
}

// onboardingUpdateArgs mirrors the frontend's Partial<OnboardingState> —
// every field optional, pointer so "field absent" is distinguishable from
// "field present with its zero value" (e.g. lastCompletedStep: 0 is a real
// value, distinct from "not sent").
type onboardingUpdateArgs struct {
	FlowVersion       *int                     `json:"flowVersion"`
	ClosedAt          *int64                   `json:"closedAt"`
	Outcome           *string                  `json:"outcome"`
	LastCompletedStep *int                     `json:"lastCompletedStep"`
	Checklist         *onboardingChecklistView `json:"checklist"`
}
