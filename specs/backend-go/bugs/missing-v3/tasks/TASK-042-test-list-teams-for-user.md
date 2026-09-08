# TASK-042: Tests for `ListTeamsForUser` usecase and the `devServer.listForUser` team-grant regression

**From Solution:** SOL-013 (Test plan)
**Priority:** P1 — closes out the fix; TASK-041's existing
`TestDevServerListForUserChannel_ResolvesDepartmentThenLists` test needs the
fake-client update this task makes or it panics on a nil-func deref at
runtime (see TASK-041's Verify note)
**Service:** `tenant-service` + `api-gateway`
**File:** `backend-go/services/tenant-service/internal/usecase/list_teams_for_user_test.go` (new), `backend-go/services/api-gateway/internal/adapter/wscompat/channels_team_test.go`, `backend-go/services/api-gateway/internal/adapter/wscompat/channels_dev_server_access_control_test.go`
**Depends on:** TASK-039, TASK-040, TASK-041
**Status:** `[x]` DONE — as specified. Confirmed by re-reading `channels_dev_server_access_control_test.go` in full before editing that exactly one caller of `registerDevServerAccessControlChannels` dispatches `"devServer.listForUser"` (the other two tests dispatch `devServer.requestAccess`/`devServerGroup.list`), matching the task doc's own note, so no other fake needed `listTeamsForUserFunc` set. All new/updated tests pass: `TestListTeamsForUser_*` (4/4, tenant-service usecase), `TestDevServerListForUserChannel_ResolvesDepartmentThenLists` (updated) and `TestDevServerListForUserChannel_ListTeamsForUserErrorFailsTheCall` (new) in wscompat, plus the full `./services/tenant-service/...` and `./services/api-gateway/internal/adapter/wscompat/...` suites (all `ok`) and the named `infra-fleet-service` confidence-check tests (8/8 pass, unaffected). While verifying, two *transient* concurrent-edit collisions from unrelated parallel agents briefly surfaced and then resolved on their own with no action from this task: (1) `tenant-service`'s `server.go`/`main.go` `New()` call site was mid-edit by another agent's StarNag work; (2) `wscompat`'s `channels_git_test.go` (a different file, `GetRemoteUrl` signature change from gitgateway proto work) briefly broke that whole test package's compile. Final re-run after both settled: build/vet/test all clean for every command this task's Verify section names. (`go vet` on the whole `./services/api-gateway/...` — broader than this task's own target — can still hit `httpgateway`'s separate `fakeTenantServiceClient` missing unrelated StarNag stubs; that fake and file are untouched by this task and out of its scope.)

---

## Context

This is the direct regression coverage for BUG-013 ("`team_ids` observed
always empty"): a usecase-level test proving `ListTeamsForUser` correctly
projects and company-scopes `TeamRepository.ListUserTeamLayers`, and a
wscompat-level test proving the built
`infrafleetv1.ListDevServersForUserRequest.TeamIds` actually carries the
resolved team IDs through `devServer.listForUser` — the one assertion that
would have caught this bug.

**Consumer-side verification, already done — no new tests needed on that
side.** SOL-013 independently verified (not just assumed)
`infra-fleet-service.ListDevServersForUser`
(`backend-go/services/infra-fleet-service/internal/usecase/list_dev_servers_for_user.go:50-131`)
already handles a populated `TeamIds` correctly: `Execute` builds a
`teamSet` from `in.TeamIDs` (`:77-80`) and `groupGrantsAccess` matches a team
grant via `grant.GranteeKind == domain.GranteeKindTeam &&
teamSet[grant.GranteeID]` (`:101`), OR'd with the department check
(`:97-100`) per CR-DS-007 §3 decision 3. This is already exercised by
`TestListDevServersForUser_TeamGrantMatches`
(`list_dev_servers_for_user_test.go:100-118`), which passes today — proving
the consumer logic was never the gap. The ancestor-inheritance walk
(`groupGrantsAccess`'s parent-chain recursion, `:106-112`) is grant-kind-
agnostic, so it applies to team grants the same way
`TestListDevServersForUser_InheritsGrantFromParentGroup` already proves for
department grants. **This task proposes no changes to
`infra-fleet-service`.**

## Changes to make

### Step 1 — new usecase unit test

Create `backend-go/services/tenant-service/internal/usecase/list_teams_for_user_test.go`,
mirroring `list_teams_test.go`'s shape and reusing the existing
`fakeTeamRepository`/`withTenant`/`mustTeam` helpers from `fakes_test.go` and
`get_resolved_profile_test.go` (same package, no new fakes needed —
`fakeTeamRepository.ListUserTeamLayers` already exists,
`fakes_test.go:389`):

```go
package usecase

import (
	"context"
	"testing"

	"github.com/stablyai/orca-go/services/tenant-service/internal/domain"
)

func TestListTeamsForUser_RequiresTenantContext(t *testing.T) {
	uc := NewListTeamsForUser(newFakeTeamRepository())
	if _, err := uc.Execute(context.Background(), ListTeamsForUserInput{UserID: "user-1"}); err == nil {
		t.Fatal("expected an error when no tenant is in context")
	}
}

func TestListTeamsForUser_ReturnsTeamIDs(t *testing.T) {
	teams := newFakeTeamRepository()
	teamA, _ := teams.Create(context.Background(), mustTeam(t, "team-a", "company-1", "Platform", nil))
	teamB, _ := teams.Create(context.Background(), mustTeam(t, "team-b", "company-1", "Growth", nil))
	_ = teams.AddMember(context.Background(), domain.TeamMember{TeamID: teamA.ID, UserID: "user-1", Priority: 1})
	_ = teams.AddMember(context.Background(), domain.TeamMember{TeamID: teamB.ID, UserID: "user-1", Priority: 2})

	uc := NewListTeamsForUser(teams)
	ctx := withTenant(context.Background(), "company-1")

	got, err := uc.Execute(ctx, ListTeamsForUserInput{UserID: "user-1"})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 team IDs, got %d: %v", len(got), got)
	}
	want := map[string]bool{"team-a": true, "team-b": true}
	for _, id := range got {
		if !want[id] {
			t.Errorf("unexpected team id %q", id)
		}
		delete(want, id)
	}
	if len(want) != 0 {
		t.Errorf("missing expected team ids: %v", want)
	}
}

func TestListTeamsForUser_ScopesByCompany(t *testing.T) {
	teams := newFakeTeamRepository()
	teamA, _ := teams.Create(context.Background(), mustTeam(t, "team-a", "company-a", "Platform", nil))
	teamOther, _ := teams.Create(context.Background(), mustTeam(t, "team-other", "company-b", "Other", nil))
	// Same user_id happens to be a member of teams in two different
	// companies — ListUserTeamLayers' join on tenant.teams.company_id must
	// only surface the caller's own company's membership.
	_ = teams.AddMember(context.Background(), domain.TeamMember{TeamID: teamA.ID, UserID: "user-1", Priority: 1})
	_ = teams.AddMember(context.Background(), domain.TeamMember{TeamID: teamOther.ID, UserID: "user-1", Priority: 1})

	uc := NewListTeamsForUser(teams)
	ctx := withTenant(context.Background(), "company-a")

	got, err := uc.Execute(ctx, ListTeamsForUserInput{UserID: "user-1"})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if len(got) != 1 || got[0] != "team-a" {
		t.Fatalf("cross-company leak: expected only [team-a], got %v", got)
	}
}

func TestListTeamsForUser_NoMemberships(t *testing.T) {
	uc := NewListTeamsForUser(newFakeTeamRepository())
	ctx := withTenant(context.Background(), "company-1")

	got, err := uc.Execute(ctx, ListTeamsForUserInput{UserID: "user-with-no-teams"})
	if err != nil {
		t.Fatalf("Execute: %v (expected no error, not-found is not applicable here)", err)
	}
	if len(got) != 0 {
		t.Fatalf("expected empty slice, got %v", got)
	}
}
```

### Step 2 — extend the shared `fakeTenantServiceClient` test double

Current code (`channels_team_test.go:20-29,53-55`):

```go
type fakeTenantServiceClient struct {
	tenantv1.TenantServiceClient

	createTeamFunc       func(ctx context.Context, in *tenantv1.CreateTeamRequest) (*tenantv1.CreateTeamResponse, error)
	listTeamsFunc        func(ctx context.Context, in *tenantv1.ListTeamsRequest) (*tenantv1.ListTeamsResponse, error)
	addTeamMemberFunc    func(ctx context.Context, in *tenantv1.AddTeamMemberRequest) (*tenantv1.AddTeamMemberResponse, error)
	removeTeamMemberFunc func(ctx context.Context, in *tenantv1.RemoveTeamMemberRequest) (*emptypb.Empty, error)
	listTeamMembersFunc  func(ctx context.Context, in *tenantv1.ListTeamMembersRequest) (*tenantv1.ListTeamMembersResponse, error)
	getUserProfileFunc   func(ctx context.Context, in *tenantv1.GetUserProfileRequest) (*tenantv1.GetUserProfileResponse, error)
}
```

Add one field:

```go
	getUserProfileFunc    func(ctx context.Context, in *tenantv1.GetUserProfileRequest) (*tenantv1.GetUserProfileResponse, error)
	listTeamsForUserFunc  func(ctx context.Context, in *tenantv1.ListTeamsForUserRequest) (*tenantv1.ListTeamsForUserResponse, error)
```

And after the existing `ListTeamMembers` method (`channels_team_test.go:53-55`):

```go
func (f *fakeTenantServiceClient) ListTeamMembers(ctx context.Context, in *tenantv1.ListTeamMembersRequest, _ ...grpc.CallOption) (*tenantv1.ListTeamMembersResponse, error) {
	return f.listTeamMembersFunc(ctx, in)
}
```

Add:

```go
// ListTeamsForUser — BUG-013's fix: devServer.listForUser
// (channels_dev_server_access_control.go) calls this to resolve the
// caller's team-based access grants.
func (f *fakeTenantServiceClient) ListTeamsForUser(ctx context.Context, in *tenantv1.ListTeamsForUserRequest, _ ...grpc.CallOption) (*tenantv1.ListTeamsForUserResponse, error) {
	return f.listTeamsForUserFunc(ctx, in)
}
```

### Step 3 — update the existing `devServer.listForUser` test, add the regression test

Current code (`channels_dev_server_access_control_test.go:17-54`):

```go
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
	wrapped, ok := result.(map[string]any)
	if !ok {
		t.Fatalf("unexpected result type %T", result)
	}
	servers, ok := wrapped["devServers"].([]devServerView)
	if !ok || len(servers) != 1 {
		t.Errorf("unexpected devServers: %v", wrapped["devServers"])
	}
}
```

Add `listTeamsForUserFunc` to the fake (required now that the handler calls
it unconditionally — see TASK-041) and add the assertion this bug is
actually about:

```go
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
```

Also add a dedicated failure-mode test (SOL-013's deliberate "fail closed"
choice):

```go
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
```

This second test needs `"errors"` added to the file's existing import block
(`channels_dev_server_access_control_test.go:1-9`).

Every other existing test in this file that dispatches `devServer.listForUser`
with a `fakeTenantServiceClient` that doesn't set `listTeamsForUserFunc`
must also get it set (check the whole file for other callers of
`registerDevServerAccessControlChannels` that then dispatch
`"devServer.listForUser"` — as of this writing there is exactly the one
test being edited above, but confirm before finishing, since a second
un-updated caller would panic on the nil func at test-run time, not at
build time).

## Verify

```bash
cd /opt/repos/orca/backend-go
go build ./services/tenant-service/... ./services/api-gateway/...
go vet ./services/tenant-service/... ./services/api-gateway/...
go test ./services/tenant-service/internal/usecase/... -run TestListTeamsForUser -count=1 -v
go test ./services/api-gateway/internal/adapter/wscompat/... -run TestDevServer -count=1 -v
go test ./services/tenant-service/... ./services/api-gateway/... -count=1
```

Expected: all new tests pass, no existing test in either package broken.
`TestListDevServersForUser_TeamGrantMatches` and
`TestListDevServersForUser_InheritsGrantFromParentGroup` in
`services/infra-fleet-service` are unaffected by this task (no files there
are touched) — run them once for confidence, not because this task changes
their behavior:

```bash
go test ./services/infra-fleet-service/internal/usecase/... -run TestListDevServersForUser -count=1 -v
```
