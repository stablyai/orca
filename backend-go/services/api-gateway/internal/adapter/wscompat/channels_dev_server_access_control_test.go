package wscompat

import (
	"context"
	"errors"
	"testing"

	infrafleetv1 "github.com/stablyai/orca-go/proto/gen/go/orca/infrafleet/v1"
	tenantv1 "github.com/stablyai/orca-go/proto/gen/go/orca/tenant/v1"
)

// TestDevServerListForUserChannel_ResolvesDepartmentThenLists guards the
// two-step orchestration devServer.listForUser does: GetUserProfile (tenant-
// service) to resolve department_id, then ListDevServersForUser (infra-
// fleet-service) with it — see that channel's doc comment for why this
// lives at the gateway edge instead of infra-fleet-service calling
// tenant-service itself.
func TestDevServerListForUserChannel_ResolvesDepartmentThenLists(t *testing.T) {
	tenantClient := &fakeTenantServiceClient{
		getUserProfileFunc: func(ctx context.Context, in *tenantv1.GetUserProfileRequest) (*tenantv1.GetUserProfileResponse, error) {
			if in.GetUserId() != "user-1" {
				t.Errorf("want user_id=user-1, got %q", in.GetUserId())
			}
			return &tenantv1.GetUserProfileResponse{
				Profile: &tenantv1.UserProfile{UserId: "user-1", DepartmentId: "dept-1"},
			}, nil
		},
		listTeamsForUserFunc: func(ctx context.Context, in *tenantv1.ListTeamsForUserRequest) (*tenantv1.ListTeamsForUserResponse, error) {
			if in.GetUserId() != "user-1" {
				t.Errorf("want user_id=user-1, got %q", in.GetUserId())
			}
			return &tenantv1.ListTeamsForUserResponse{TeamIds: []string{"team-1", "team-2"}}, nil
		},
	}
	infraClient := &fakeInfraFleetClient{
		listDevServersForUserFunc: func(ctx context.Context, in *infrafleetv1.ListDevServersForUserRequest) (*infrafleetv1.ListDevServersForUserResponse, error) {
			return &infrafleetv1.ListDevServersForUserResponse{
				DevServers: []*infrafleetv1.DevServer{{Id: "ds1"}},
			}, nil
		},
	}

	r := NewRegistry()
	registerDevServerAccessControlChannels(r, infraClient, tenantClient)

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1", UserID: "user-1"}, "devServer.listForUser", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if infraClient.lastListDevServersForUserIn.GetDepartmentId() != "dept-1" {
		t.Errorf("want department_id=dept-1 threaded through, got %q", infraClient.lastListDevServersForUserIn.GetDepartmentId())
	}
	// This is the actual BUG-013 regression assertion: team_ids resolved
	// via ListTeamsForUser must reach the downstream fleet request, not be
	// silently dropped as empty.
	gotTeamIDs := infraClient.lastListDevServersForUserIn.GetTeamIds()
	if len(gotTeamIDs) != 2 || gotTeamIDs[0] != "team-1" || gotTeamIDs[1] != "team-2" {
		t.Errorf("want team_ids=[team-1 team-2] threaded through, got %v", gotTeamIDs)
	}
	wrapped, ok := result.(map[string]any)
	if !ok {
		t.Fatalf("unexpected result type %T", result)
	}
	servers, ok := wrapped["devServers"].([]devServerView)
	if !ok || len(servers) != 1 {
		t.Errorf("unexpected devServers: %v", wrapped["devServers"])
	}
}

// TestDevServerListForUserChannel_ListTeamsForUserErrorFailsTheCall guards
// SOL-013's deliberate choice: a ListTeamsForUser error must fail the whole
// call rather than silently degrade to department-only (which would
// reproduce BUG-013's under-provisioning under a new trigger).
func TestDevServerListForUserChannel_ListTeamsForUserErrorFailsTheCall(t *testing.T) {
	tenantClient := &fakeTenantServiceClient{
		getUserProfileFunc: func(ctx context.Context, in *tenantv1.GetUserProfileRequest) (*tenantv1.GetUserProfileResponse, error) {
			return &tenantv1.GetUserProfileResponse{Profile: &tenantv1.UserProfile{UserId: "user-1", DepartmentId: "dept-1"}}, nil
		},
		listTeamsForUserFunc: func(ctx context.Context, in *tenantv1.ListTeamsForUserRequest) (*tenantv1.ListTeamsForUserResponse, error) {
			return nil, errors.New("tenant-service unavailable")
		},
	}
	infraClient := &fakeInfraFleetClient{
		listDevServersForUserFunc: func(ctx context.Context, in *infrafleetv1.ListDevServersForUserRequest) (*infrafleetv1.ListDevServersForUserResponse, error) {
			t.Fatal("ListDevServersForUser must not be called when ListTeamsForUser fails")
			return nil, nil
		},
	}

	r := NewRegistry()
	registerDevServerAccessControlChannels(r, infraClient, tenantClient)

	_, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1", UserID: "user-1"}, "devServer.listForUser", nil)
	if err == nil {
		t.Fatal("expected an error when ListTeamsForUser fails")
	}
}

// TestDevServerRequestAccessChannel_RejectsNoDepartment guards the fail-
// closed check: a caller with no department set must not be able to file
// an access request captured against an empty grantee.
func TestDevServerRequestAccessChannel_RejectsNoDepartment(t *testing.T) {
	tenantClient := &fakeTenantServiceClient{
		getUserProfileFunc: func(ctx context.Context, in *tenantv1.GetUserProfileRequest) (*tenantv1.GetUserProfileResponse, error) {
			return &tenantv1.GetUserProfileResponse{Profile: &tenantv1.UserProfile{UserId: "user-1", DepartmentId: ""}}, nil
		},
	}
	infraClient := &fakeInfraFleetClient{
		createAccessRequestFunc: func(ctx context.Context, in *infrafleetv1.CreateAccessRequestRequest) (*infrafleetv1.CreateAccessRequestResponse, error) {
			t.Fatal("CreateAccessRequest must not be called when the caller has no department")
			return nil, nil
		},
	}

	r := NewRegistry()
	registerDevServerAccessControlChannels(r, infraClient, tenantClient)

	args := argsJSON(t, map[string]any{"devServerGroupId": "g1", "message": "please"})
	_, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1", UserID: "user-1"}, "devServer.requestAccess", args)
	if err == nil {
		t.Fatal("expected an error for a caller with no department")
	}
}

func TestDevServerRequestAccessChannel_SendsCallersDepartmentAsGrantee(t *testing.T) {
	tenantClient := &fakeTenantServiceClient{
		getUserProfileFunc: func(ctx context.Context, in *tenantv1.GetUserProfileRequest) (*tenantv1.GetUserProfileResponse, error) {
			return &tenantv1.GetUserProfileResponse{Profile: &tenantv1.UserProfile{UserId: "user-1", DepartmentId: "dept-1"}}, nil
		},
	}
	infraClient := &fakeInfraFleetClient{
		createAccessRequestFunc: func(ctx context.Context, in *infrafleetv1.CreateAccessRequestRequest) (*infrafleetv1.CreateAccessRequestResponse, error) {
			return &infrafleetv1.CreateAccessRequestResponse{Request: &infrafleetv1.DevServerAccessRequest{Id: "req1"}}, nil
		},
	}

	r := NewRegistry()
	registerDevServerAccessControlChannels(r, infraClient, tenantClient)

	args := argsJSON(t, map[string]any{"devServerGroupId": "g1", "message": "please"})
	if _, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1", UserID: "user-1"}, "devServer.requestAccess", args); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if infraClient.lastCreateAccessRequestIn.GetGranteeId() != "dept-1" {
		t.Errorf("want grantee_id=dept-1, got %q", infraClient.lastCreateAccessRequestIn.GetGranteeId())
	}
	if infraClient.lastCreateAccessRequestIn.GetGranteeKind() != infrafleetv1.DevServerGroupGranteeKind_DEV_SERVER_GROUP_GRANTEE_KIND_DEPARTMENT {
		t.Errorf("want grantee_kind=DEPARTMENT, got %v", infraClient.lastCreateAccessRequestIn.GetGranteeKind())
	}
}

// TestDevServerGroupListChannel_ReturnsEmptyArrayNotNull mirrors the
// established "no silent null" convention (repo.list, devServer.
// listSshTargets) for this channel's list wrapper.
func TestDevServerGroupListChannel_ReturnsEmptyArrayNotNull(t *testing.T) {
	tenantClient := &fakeTenantServiceClient{}
	infraClient := &fakeInfraFleetClient{
		listDevServerGroupsFunc: func(ctx context.Context, in *infrafleetv1.ListDevServerGroupsRequest) (*infrafleetv1.ListDevServerGroupsResponse, error) {
			return &infrafleetv1.ListDevServerGroupsResponse{}, nil
		},
	}

	r := NewRegistry()
	registerDevServerAccessControlChannels(r, infraClient, tenantClient)

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1", UserID: "admin-1", Role: "admin"}, "devServerGroup.list", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	wrapped, ok := result.(map[string]any)
	if !ok {
		t.Fatalf("unexpected result type %T", result)
	}
	groups, ok := wrapped["groups"].([]devServerGroupView)
	if !ok || len(groups) != 0 {
		t.Errorf("want empty (non-nil) groups slice, got %v", wrapped["groups"])
	}
}
