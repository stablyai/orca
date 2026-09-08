package wscompat

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	infrafleetv1 "github.com/stablyai/orca-go/proto/gen/go/orca/infrafleet/v1"
	tenantv1 "github.com/stablyai/orca-go/proto/gen/go/orca/tenant/v1"
)

// fakeTenantServiceClientForOnboarding is a minimal fake local to this test
// file, mirroring fakeTenantServiceClientForAdmin's exact shape
// (channels_admin_users_test.go) — embed the nil tenantv1.TenantServiceClient
// interface, override only the methods onboarding.detectAgentsAllServers
// actually calls.
type fakeTenantServiceClientForOnboarding struct {
	tenantv1.TenantServiceClient
	getUserProfileFunc   func(context.Context, *tenantv1.GetUserProfileRequest) (*tenantv1.GetUserProfileResponse, error)
	listTeamsForUserFunc func(context.Context, *tenantv1.ListTeamsForUserRequest) (*tenantv1.ListTeamsForUserResponse, error)
}

func (f *fakeTenantServiceClientForOnboarding) GetUserProfile(ctx context.Context, in *tenantv1.GetUserProfileRequest, _ ...grpc.CallOption) (*tenantv1.GetUserProfileResponse, error) {
	return f.getUserProfileFunc(ctx, in)
}

func (f *fakeTenantServiceClientForOnboarding) ListTeamsForUser(ctx context.Context, in *tenantv1.ListTeamsForUserRequest, _ ...grpc.CallOption) (*tenantv1.ListTeamsForUserResponse, error) {
	if f.listTeamsForUserFunc != nil {
		return f.listTeamsForUserFunc(ctx, in)
	}
	return &tenantv1.ListTeamsForUserResponse{}, nil
}

// ── TASK-027: relay-copy channels ───────────────────────────────────────────

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

// ── TASK-028: detectAgentsAllServers fan-out ────────────────────────────────

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

// ── TASK-029: getPreflightStatus ────────────────────────────────────────────

func TestOnboardingGetPreflightStatus_RelaysToAgentContractB(t *testing.T) {
	var gotMethod string
	fake := &fakeInfraFleetClient{
		relayByDevServerFunc: func(ctx context.Context, in *infrafleetv1.RelayByDevServerRequest) (*infrafleetv1.RelayResponse, error) {
			gotMethod = in.GetMethod()
			return &infrafleetv1.RelayResponse{ResultJson: `{"platform":"linux","gh":{"installed":true,"authenticated":true,"login":"octocat"},"glab":{"installed":false,"authenticated":false},"git":{"installed":true,"identity":{"name":"A","email":"a@x.com"}}}`}, nil
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
		t.Fatal("onboarding.getPreflightStatus must NOT return the same gh status as the local preflight.check channel — they answer different questions (agent host OS vs. backend-go's own OAuth-vs-CLI design)")
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

// ── TASK-030: onboarding.openGhAuthTerminal ─────────────────────────────────

// fakeOnboardingGhAuthInfraFleetClient wraps fakeTerminalInfraFleetClient
// (channels_terminal_test.go) — same InfraFleetServiceClient double
// terminal.create's own tests use for SpawnTerminalSession/AttachPty — and
// adds the one extra method onboarding.openGhAuthTerminal needs on top:
// ResolveConnection, to turn the caller's devServerId into a connectionId.
type fakeOnboardingGhAuthInfraFleetClient struct {
	*fakeTerminalInfraFleetClient
	resolveConnectionFunc func(*infrafleetv1.ResolveConnectionRequest) (*infrafleetv1.ResolveConnectionResponse, error)
}

func (f *fakeOnboardingGhAuthInfraFleetClient) ResolveConnection(_ context.Context, in *infrafleetv1.ResolveConnectionRequest, _ ...grpc.CallOption) (*infrafleetv1.ResolveConnectionResponse, error) {
	return f.resolveConnectionFunc(in)
}

func newFakeOnboardingGhAuthInfraFleetClient() *fakeOnboardingGhAuthInfraFleetClient {
	return &fakeOnboardingGhAuthInfraFleetClient{fakeTerminalInfraFleetClient: &fakeTerminalInfraFleetClient{}}
}

// TestOnboardingOpenGhAuthTerminal_ResolvesConnectionSpawnsPtyAndTypesCommand
// is the success-path regression: devServerId resolves to a connectionId,
// SpawnTerminalSession is called with THAT connectionId (not the raw
// devServerId), AttachPty opens, and "gh auth login\n" is typed into the pty
// as terminal input — exactly what terminal.send does for a normal pty,
// mirroring the real desktop precedent (openGhAuthTerminalForDevServer).
func TestOnboardingOpenGhAuthTerminal_ResolvesConnectionSpawnsPtyAndTypesCommand(t *testing.T) {
	fake := newFakeOnboardingGhAuthInfraFleetClient()
	fake.resolveConnectionFunc = func(in *infrafleetv1.ResolveConnectionRequest) (*infrafleetv1.ResolveConnectionResponse, error) {
		if in.GetDevServerId() != "ds-1" {
			t.Errorf("expected ResolveConnection to be called with devServerId=ds-1, got %+v", in)
		}
		return &infrafleetv1.ResolveConnectionResponse{Connected: true, ConnectionId: "conn-1"}, nil
	}
	fake.spawnFunc = func(in *infrafleetv1.SpawnTerminalSessionRequest) (*infrafleetv1.SpawnTerminalSessionResponse, error) {
		if in.GetConnectionId() != "conn-1" {
			t.Errorf("expected SpawnTerminalSession to use the RESOLVED connectionId, got %+v", in)
		}
		return &infrafleetv1.SpawnTerminalSessionResponse{
			Session: &infrafleetv1.TerminalSession{PtyId: "pty-gh-1", ConnectionId: "conn-1"},
		}, nil
	}

	r := NewRegistry()
	registerOnboardingChannels(r, fake, nil)

	ack, events, isStream, err := r.DispatchStreamChannel(newTerminalTestCtx(), Identity{TenantID: "tenant-1", UserID: "user-1"},
		"onboarding.openGhAuthTerminal", argsJSON(t, map[string]any{"devServerId": "ds-1"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !isStream {
		t.Fatal("expected onboarding.openGhAuthTerminal to be registered as a StreamChannelHandler")
	}
	if events == nil {
		t.Fatal("expected a non-nil push events channel")
	}
	view, ok := ack.(onboardingOpenGhAuthTerminalResultView)
	if !ok || view.PtyID != "pty-gh-1" || view.DevServerID != "ds-1" {
		t.Fatalf("unexpected ack: %+v", ack)
	}

	if fake.lastStream == nil {
		t.Fatal("expected AttachPty to have been called")
	}
	attachFrame := awaitSentFrame(t, fake.lastStream)
	if attach := attachFrame.GetAttach(); attach == nil || attach.GetPtyId() != "pty-gh-1" {
		t.Errorf("expected the stream's first frame to be an attach frame for pty-gh-1, got %+v", attachFrame)
	}

	inputFrame := awaitSentFrame(t, fake.lastStream)
	input := inputFrame.GetInput()
	if input == nil || string(input.GetData()) != "gh auth login\n" {
		t.Errorf("expected the second frame to type 'gh auth login\\n', got %+v", inputFrame)
	}
}

// TestOnboardingOpenGhAuthTerminal_DevServerNotConnected_ReturnsExpectedError
// covers the "resolved but no live agent session" case as a normal,
// expected onboarding state (not a crash) — mirrors
// onboardingGetPreflightStatus's identical ONBOARDING_DEV_SERVER_NOT_CONNECTED
// convention for the same situation.
func TestOnboardingOpenGhAuthTerminal_DevServerNotConnected_ReturnsExpectedError(t *testing.T) {
	fake := newFakeOnboardingGhAuthInfraFleetClient()
	fake.resolveConnectionFunc = func(*infrafleetv1.ResolveConnectionRequest) (*infrafleetv1.ResolveConnectionResponse, error) {
		return &infrafleetv1.ResolveConnectionResponse{Connected: false}, nil
	}
	fake.spawnFunc = func(*infrafleetv1.SpawnTerminalSessionRequest) (*infrafleetv1.SpawnTerminalSessionResponse, error) {
		t.Fatal("SpawnTerminalSession must not be called when the dev server is not connected")
		return nil, nil
	}

	r := NewRegistry()
	registerOnboardingChannels(r, fake, nil)

	_, events, isStream, err := r.DispatchStreamChannel(newTerminalTestCtx(), Identity{TenantID: "tenant-1"},
		"onboarding.openGhAuthTerminal", argsJSON(t, map[string]any{"devServerId": "ds-1"}))
	if !isStream {
		t.Fatal("expected onboarding.openGhAuthTerminal to be registered as a StreamChannelHandler")
	}
	if err == nil {
		t.Fatal("expected an error when the dev server has no live agent session")
	}
	if !strings.Contains(err.Error(), "ONBOARDING_DEV_SERVER_NOT_CONNECTED") {
		t.Errorf("expected an ONBOARDING_DEV_SERVER_NOT_CONNECTED error, got %v", err)
	}
	if events != nil {
		t.Error("expected a nil events channel when not connected")
	}
}

// TestOnboardingOpenGhAuthTerminal_RequiresDevServerID guards the same
// fail-closed argument check every other devServerId-keyed onboarding
// channel in this file has.
func TestOnboardingOpenGhAuthTerminal_RequiresDevServerID(t *testing.T) {
	r := NewRegistry()
	registerOnboardingChannels(r, newFakeOnboardingGhAuthInfraFleetClient(), nil)

	_, _, _, err := r.DispatchStreamChannel(newTerminalTestCtx(), Identity{TenantID: "tenant-1"},
		"onboarding.openGhAuthTerminal", argsJSON(t, map[string]any{}))
	if err == nil {
		t.Fatal("expected an error when devServerId is omitted")
	}
}
