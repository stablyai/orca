package wscompat

import (
	"context"
	"encoding/json"
	"testing"

	"google.golang.org/grpc"
	"google.golang.org/protobuf/types/known/emptypb"

	tenantv1 "github.com/stablyai/orca-go/proto/gen/go/orca/tenant/v1"
)

// fakeTenantServiceClient is a minimal test double for
// tenantv1.TenantServiceClient — embeds the (nil) interface so it satisfies
// every method, and overrides only the ones this file's channel handlers
// actually call. Calling an unset method panics on a nil-pointer deref,
// which is fine: no test here should ever reach one. Same pattern as
// fakeInfraFleetClient in channels_test.go.
type fakeTenantServiceClient struct {
	tenantv1.TenantServiceClient

	createTeamFunc       func(ctx context.Context, in *tenantv1.CreateTeamRequest) (*tenantv1.CreateTeamResponse, error)
	listTeamsFunc        func(ctx context.Context, in *tenantv1.ListTeamsRequest) (*tenantv1.ListTeamsResponse, error)
	addTeamMemberFunc    func(ctx context.Context, in *tenantv1.AddTeamMemberRequest) (*tenantv1.AddTeamMemberResponse, error)
	removeTeamMemberFunc func(ctx context.Context, in *tenantv1.RemoveTeamMemberRequest) (*emptypb.Empty, error)
	listTeamMembersFunc  func(ctx context.Context, in *tenantv1.ListTeamMembersRequest) (*tenantv1.ListTeamMembersResponse, error)
	getUserProfileFunc   func(ctx context.Context, in *tenantv1.GetUserProfileRequest) (*tenantv1.GetUserProfileResponse, error)
	listTeamsForUserFunc func(ctx context.Context, in *tenantv1.ListTeamsForUserRequest) (*tenantv1.ListTeamsForUserResponse, error)

	// starNag.* (TASK-011/012) — see channels_star_nag_test.go.
	dismissStarNagFunc                      func(ctx context.Context, in *tenantv1.DismissStarNagRequest) (*emptypb.Empty, error)
	deferStarNagFunc                        func(ctx context.Context, in *tenantv1.DeferStarNagRequest) (*emptypb.Empty, error)
	completeStarNagFunc                     func(ctx context.Context, in *tenantv1.CompleteStarNagRequest) (*emptypb.Empty, error)
	disableStarNagFunc                      func(ctx context.Context, in *tenantv1.DisableStarNagRequest) (*emptypb.Empty, error)
	forceShowStarNagFunc                    func(ctx context.Context, in *tenantv1.ForceShowStarNagRequest) (*emptypb.Empty, error)
	notifyStarNagOnboardingCompletedFunc    func(ctx context.Context, in *tenantv1.NotifyStarNagOnboardingCompletedRequest) (*emptypb.Empty, error)
	openWebStarNagFunc                      func(ctx context.Context, in *tenantv1.OpenWebStarNagRequest) (*emptypb.Empty, error)
	starOrcaFromNagFunc                     func(ctx context.Context, in *tenantv1.StarOrcaFromNagRequest) (*tenantv1.StarOrcaFromNagResponse, error)
	prepareStarNagAgentValueMomentFunc      func(ctx context.Context, in *tenantv1.PrepareStarNagAgentValueMomentRequest) (*tenantv1.StarNagAgentValueMomentPreparation, error)
	showPreparedStarNagAgentValueMomentFunc func(ctx context.Context, in *tenantv1.ShowPreparedStarNagAgentValueMomentRequest) (*emptypb.Empty, error)
}

// GetUserProfile — CR-DS-007/CR-DS-008's devServer.listForUser/
// devServer.requestAccess channels (channels_dev_server_access_control.go).
func (f *fakeTenantServiceClient) GetUserProfile(ctx context.Context, in *tenantv1.GetUserProfileRequest, _ ...grpc.CallOption) (*tenantv1.GetUserProfileResponse, error) {
	return f.getUserProfileFunc(ctx, in)
}

func (f *fakeTenantServiceClient) CreateTeam(ctx context.Context, in *tenantv1.CreateTeamRequest, _ ...grpc.CallOption) (*tenantv1.CreateTeamResponse, error) {
	return f.createTeamFunc(ctx, in)
}

func (f *fakeTenantServiceClient) ListTeams(ctx context.Context, in *tenantv1.ListTeamsRequest, _ ...grpc.CallOption) (*tenantv1.ListTeamsResponse, error) {
	return f.listTeamsFunc(ctx, in)
}

func (f *fakeTenantServiceClient) AddTeamMember(ctx context.Context, in *tenantv1.AddTeamMemberRequest, _ ...grpc.CallOption) (*tenantv1.AddTeamMemberResponse, error) {
	return f.addTeamMemberFunc(ctx, in)
}

func (f *fakeTenantServiceClient) RemoveTeamMember(ctx context.Context, in *tenantv1.RemoveTeamMemberRequest, _ ...grpc.CallOption) (*emptypb.Empty, error) {
	return f.removeTeamMemberFunc(ctx, in)
}

func (f *fakeTenantServiceClient) ListTeamMembers(ctx context.Context, in *tenantv1.ListTeamMembersRequest, _ ...grpc.CallOption) (*tenantv1.ListTeamMembersResponse, error) {
	return f.listTeamMembersFunc(ctx, in)
}

// ListTeamsForUser — BUG-013's fix: devServer.listForUser
// (channels_dev_server_access_control.go) calls this to resolve the
// caller's team-based access grants.
func (f *fakeTenantServiceClient) ListTeamsForUser(ctx context.Context, in *tenantv1.ListTeamsForUserRequest, _ ...grpc.CallOption) (*tenantv1.ListTeamsForUserResponse, error) {
	return f.listTeamsForUserFunc(ctx, in)
}

func (f *fakeTenantServiceClient) DismissStarNag(ctx context.Context, in *tenantv1.DismissStarNagRequest, _ ...grpc.CallOption) (*emptypb.Empty, error) {
	return f.dismissStarNagFunc(ctx, in)
}

func (f *fakeTenantServiceClient) DeferStarNag(ctx context.Context, in *tenantv1.DeferStarNagRequest, _ ...grpc.CallOption) (*emptypb.Empty, error) {
	return f.deferStarNagFunc(ctx, in)
}

func (f *fakeTenantServiceClient) CompleteStarNag(ctx context.Context, in *tenantv1.CompleteStarNagRequest, _ ...grpc.CallOption) (*emptypb.Empty, error) {
	return f.completeStarNagFunc(ctx, in)
}

func (f *fakeTenantServiceClient) DisableStarNag(ctx context.Context, in *tenantv1.DisableStarNagRequest, _ ...grpc.CallOption) (*emptypb.Empty, error) {
	return f.disableStarNagFunc(ctx, in)
}

func (f *fakeTenantServiceClient) ForceShowStarNag(ctx context.Context, in *tenantv1.ForceShowStarNagRequest, _ ...grpc.CallOption) (*emptypb.Empty, error) {
	return f.forceShowStarNagFunc(ctx, in)
}

func (f *fakeTenantServiceClient) NotifyStarNagOnboardingCompleted(ctx context.Context, in *tenantv1.NotifyStarNagOnboardingCompletedRequest, _ ...grpc.CallOption) (*emptypb.Empty, error) {
	return f.notifyStarNagOnboardingCompletedFunc(ctx, in)
}

func (f *fakeTenantServiceClient) OpenWebStarNag(ctx context.Context, in *tenantv1.OpenWebStarNagRequest, _ ...grpc.CallOption) (*emptypb.Empty, error) {
	return f.openWebStarNagFunc(ctx, in)
}

func (f *fakeTenantServiceClient) StarOrcaFromNag(ctx context.Context, in *tenantv1.StarOrcaFromNagRequest, _ ...grpc.CallOption) (*tenantv1.StarOrcaFromNagResponse, error) {
	return f.starOrcaFromNagFunc(ctx, in)
}

func (f *fakeTenantServiceClient) PrepareStarNagAgentValueMoment(ctx context.Context, in *tenantv1.PrepareStarNagAgentValueMomentRequest, _ ...grpc.CallOption) (*tenantv1.StarNagAgentValueMomentPreparation, error) {
	return f.prepareStarNagAgentValueMomentFunc(ctx, in)
}

func (f *fakeTenantServiceClient) ShowPreparedStarNagAgentValueMoment(ctx context.Context, in *tenantv1.ShowPreparedStarNagAgentValueMomentRequest, _ ...grpc.CallOption) (*emptypb.Empty, error) {
	return f.showPreparedStarNagAgentValueMomentFunc(ctx, in)
}

func TestTeamCreateChannel_Success(t *testing.T) {
	var gotReq *tenantv1.CreateTeamRequest
	var gotCtx context.Context
	fake := &fakeTenantServiceClient{
		createTeamFunc: func(ctx context.Context, in *tenantv1.CreateTeamRequest) (*tenantv1.CreateTeamResponse, error) {
			gotCtx = ctx
			gotReq = in
			return &tenantv1.CreateTeamResponse{Team: &tenantv1.Team{Id: "team-1", CompanyId: in.CompanyId, Name: in.Name, SettingsJson: in.SettingsJson}}, nil
		},
	}

	r := NewRegistry()
	registerTeamChannels(r, fake)

	args := argsJSON(t, map[string]string{"name": "Platform", "settingsJson": `{"a":1}`})
	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1", UserID: "user-1", Role: "admin"}, "team.create", args)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	team, ok := result.(*tenantv1.Team)
	if !ok {
		t.Fatalf("unexpected result type %T", result)
	}
	if team.Id != "team-1" {
		t.Errorf("expected team id team-1, got %q", team.Id)
	}
	if gotReq.CompanyId != "tenant-1" {
		t.Errorf("expected CompanyId=tenant-1 (from Identity.TenantID), got %q", gotReq.CompanyId)
	}
	if gotReq.Name != "Platform" {
		t.Errorf("expected Name=Platform, got %q", gotReq.Name)
	}
	if gotReq.SettingsJson != `{"a":1}` {
		t.Errorf("expected SettingsJson to round-trip, got %q", gotReq.SettingsJson)
	}
	tenant, user := outgoingTenantUser(gotCtx)
	if tenant != "tenant-1" || user != "user-1" {
		t.Errorf("expected AttachIdentity to stamp tenant-1/user-1 onto outgoing metadata, got tenant=%q user=%q", tenant, user)
	}
}

func TestTeamListChannel_Success(t *testing.T) {
	fake := &fakeTenantServiceClient{
		listTeamsFunc: func(ctx context.Context, in *tenantv1.ListTeamsRequest) (*tenantv1.ListTeamsResponse, error) {
			return &tenantv1.ListTeamsResponse{Teams: []*tenantv1.Team{
				{Id: "team-1", CompanyId: "tenant-1", Name: "Platform"},
				{Id: "team-2", CompanyId: "tenant-1", Name: "Growth"},
			}}, nil
		},
	}

	r := NewRegistry()
	registerTeamChannels(r, fake)

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1", UserID: "user-1", Role: "admin"}, "team.list", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	teams, ok := result.([]*tenantv1.Team)
	if !ok {
		t.Fatalf("unexpected result type %T", result)
	}
	if len(teams) != 2 {
		t.Fatalf("expected 2 teams, got %d", len(teams))
	}
}

// TestTeamListChannel_EmptyResult_ReturnsEmptyArrayNotNull is the direct
// regression test for BUG-005 (specs/backend-go/bugs/missing-v2/): an
// empty ListTeamsResponse leaves Teams as a nil slice, normalized to []
// by Registry.Dispatch before it reaches the frontend.
func TestTeamListChannel_EmptyResult_ReturnsEmptyArrayNotNull(t *testing.T) {
	fake := &fakeTenantServiceClient{
		listTeamsFunc: func(ctx context.Context, in *tenantv1.ListTeamsRequest) (*tenantv1.ListTeamsResponse, error) {
			return &tenantv1.ListTeamsResponse{}, nil // Teams left nil
		},
	}

	r := NewRegistry()
	registerTeamChannels(r, fake)

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1", UserID: "user-1", Role: "admin"}, "team.list", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	b, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if string(b) != "[]" {
		t.Errorf("expected [], got %s", b)
	}
}

func TestTeamAddMemberChannel_Success(t *testing.T) {
	var gotReq *tenantv1.AddTeamMemberRequest
	fake := &fakeTenantServiceClient{
		addTeamMemberFunc: func(ctx context.Context, in *tenantv1.AddTeamMemberRequest) (*tenantv1.AddTeamMemberResponse, error) {
			gotReq = in
			return &tenantv1.AddTeamMemberResponse{}, nil
		},
	}

	r := NewRegistry()
	registerTeamChannels(r, fake)

	// role is decoded (must not error) but intentionally dropped — it has
	// nowhere to go on AddTeamMemberRequest.
	args := argsJSON(t, map[string]any{"teamId": "team-1", "userId": "user-1", "role": "admin", "priority": 7})
	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1", UserID: "user-1", Role: "admin"}, "team.addMember", args)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	ok, isMap := result.(map[string]bool)
	if !isMap || !ok["ok"] {
		t.Fatalf("expected {ok: true}, got %#v", result)
	}
	if gotReq.TeamId != "team-1" || gotReq.UserId != "user-1" || gotReq.Priority != 7 {
		t.Fatalf("unexpected request: %+v", gotReq)
	}
}

func TestTeamRemoveMemberChannel_Success(t *testing.T) {
	var gotReq *tenantv1.RemoveTeamMemberRequest
	fake := &fakeTenantServiceClient{
		removeTeamMemberFunc: func(ctx context.Context, in *tenantv1.RemoveTeamMemberRequest) (*emptypb.Empty, error) {
			gotReq = in
			return &emptypb.Empty{}, nil
		},
	}

	r := NewRegistry()
	registerTeamChannels(r, fake)

	args := argsJSON(t, map[string]string{"teamId": "team-1", "userId": "user-1"})
	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1", UserID: "user-1", Role: "admin"}, "team.removeMember", args)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	ok, isMap := result.(map[string]bool)
	if !isMap || !ok["ok"] {
		t.Fatalf("expected {ok: true}, got %#v", result)
	}
	if gotReq.TeamId != "team-1" || gotReq.UserId != "user-1" {
		t.Fatalf("unexpected request: %+v", gotReq)
	}
}

func TestTeamListMembersChannel_Success(t *testing.T) {
	var gotReq *tenantv1.ListTeamMembersRequest
	fake := &fakeTenantServiceClient{
		listTeamMembersFunc: func(ctx context.Context, in *tenantv1.ListTeamMembersRequest) (*tenantv1.ListTeamMembersResponse, error) {
			gotReq = in
			return &tenantv1.ListTeamMembersResponse{Members: []*tenantv1.TeamMember{
				{UserId: "user-1", Priority: 1},
				{UserId: "user-2", Priority: 2},
			}}, nil
		},
	}

	r := NewRegistry()
	registerTeamChannels(r, fake)

	args := argsJSON(t, map[string]string{"teamId": "team-1"})
	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1", UserID: "user-1", Role: "admin"}, "team.listMembers", args)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	members, isSlice := result.([]*tenantv1.TeamMember)
	if !isSlice || len(members) != 2 {
		t.Fatalf("unexpected result: %#v", result)
	}
	if gotReq.TeamId != "team-1" {
		t.Fatalf("expected TeamId=team-1, got %q", gotReq.TeamId)
	}
}

// TestTeamChannels_RequireAdmin is the regression guard for TASK-BE-032's
// admin-gating pass — all 5 team.* channels were unauthenticated-by-role
// before it (any caller, not just admins, could create/list/modify teams).
func TestTeamChannels_RequireAdmin(t *testing.T) {
	r := NewRegistry()
	registerTeamChannels(r, &fakeTenantServiceClient{})

	nonAdmin := Identity{TenantID: "tenant-1", UserID: "user-1", Role: "developer"}
	for _, method := range []string{"team.create", "team.list", "team.addMember", "team.removeMember", "team.listMembers"} {
		if _, err := r.Dispatch(context.Background(), nonAdmin, method, nil); err != errNotAdmin {
			t.Errorf("%s: expected errNotAdmin for a non-admin caller, got %v", method, err)
		}
	}
}
