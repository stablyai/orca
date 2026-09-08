# TASK-040: Implement `ListTeamsForUser` usecase, wire it into the gRPC server adapter and `main.go`

**From Solution:** SOL-013 (Design — `usecase/` layer)
**Priority:** P0 — do right after TASK-039; nothing else in this bug's fix
can compile without this
**Service:** `tenant-service`
**File:** `backend-go/services/tenant-service/internal/usecase/list_teams_for_user.go` (new), `backend-go/services/tenant-service/internal/adapter/grpc/server.go`, `backend-go/services/tenant-service/cmd/server/main.go`
**Depends on:** TASK-039
**Status:** `[x]` DONE — as specified. Current `server.go`/`main.go` content matched the sketch exactly (only cosmetic line-number drift from when the task doc was written); no `ports.go` change needed since `TeamRepository.ListUserTeamLayers` was already declared. `go build`/`go vet` clean, no gofmt diffs; `internal/adapter/grpc` package has no test files today so `go test` there is a no-op (`[no test files]`) rather than a pass/fail signal — TASK-042 adds real coverage at the usecase and wscompat layers instead.

---

## Context

The repository query this RPC needs already exists:
`TeamRepository.ListUserTeamLayers(ctx, companyID, userID) ([]domain.TeamSettingsLayer, error)`
(`backend-go/services/tenant-service/internal/adapter/postgres/team_repository.go:148-177`)
already runs exactly the join BUG-013 needs, and is already declared on the
port (`internal/usecase/ports.go:126-130`) and already used by
`GetResolvedProfile` (`internal/usecase/get_resolved_profile.go:64`). **No
new repository method, no new SQL, no new index** — the new usecase only
projects `TeamID` out of the slice `ListUserTeamLayers` already returns.
This task also wires the new usecase into the gRPC inbound adapter and the
composition root, since a usecase with no `Server` method or `main.go`
constructor call is dead code — SOL-013's design section only sketched the
usecase file itself, but the existing `ListTeams`/`ListTeamMembers` pattern
(same file, `server.go`) makes clear a matching `Server` method and
`New()`/`main.go` wiring are part of the same unit of work (see
`specs/backend-go/bugs/missing-v1/tasks/TASK-084-implement-gitlab-usecases-and-adapter.md`
for this repo's own precedent of bundling usecase + adapter wiring into one
task).

## Changes to make

### Step 1 — new usecase file

Create `backend-go/services/tenant-service/internal/usecase/list_teams_for_user.go`:

```go
package usecase

import (
	"context"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/common/tenant"
)

// ListTeamsForUserInput mirrors ListTeamsForUserRequest 1:1.
type ListTeamsForUserInput struct {
	UserID string
}

// ListTeamsForUser answers "which teams is this user in" — the RPC
// devServer.listForUser's handler doc comment names as missing
// (channels_dev_server_access_control.go:279-284, BUG-013). Thin: reuses
// TeamRepository.ListUserTeamLayers, the same indexed
// (tenant.team_members.user_id) query GetResolvedProfile already runs for
// its team settings-layer — no new repository method.
type ListTeamsForUser struct {
	teams TeamRepository
}

func NewListTeamsForUser(teams TeamRepository) *ListTeamsForUser {
	return &ListTeamsForUser{teams: teams}
}

func (uc *ListTeamsForUser) Execute(ctx context.Context, in ListTeamsForUserInput) ([]string, error) {
	companyID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return nil, apperrors.New(apperrors.KindUnauthenticated, "TENANT_NO_TENANT", "no tenant in request context", err)
	}

	layers, err := uc.teams.ListUserTeamLayers(ctx, companyID, in.UserID)
	if err != nil {
		return nil, apperrors.New(apperrors.KindInternal, "TENANT_LIST_TEAMS_FOR_USER_FAILED", "failed to list teams for user", err)
	}

	teamIDs := make([]string, 0, len(layers))
	for _, layer := range layers {
		teamIDs = append(teamIDs, layer.TeamID)
	}
	return teamIDs, nil
}
```

No `ports.go` change needed — `TeamRepository.ListUserTeamLayers` is already
declared there (`internal/usecase/ports.go:126-130`).

A user with zero team memberships gets `layers == nil`, so `teamIDs` comes
back as an empty (non-nil, len-0) slice — mirrors `ListTeams.Execute`'s own
"no rows is not an error" posture (`list_teams.go:20-30`). This call
intentionally never validates that the user exists: a user with no
`tenant.team_members` rows and a user who doesn't exist look identical from
this query and both correctly resolve to "no teams" (unlike
`ListTeamMembers`, which 404s an unknown `team_id`).

### Step 2 — add the `Server` field, constructor param, and RPC method

Current code (`backend-go/services/tenant-service/internal/adapter/grpc/server.go:29-56`):

```go
// Server implements tenantv1.UnimplementedTenantServiceServer.
type Server struct {
	tenantv1.UnimplementedTenantServiceServer

	createCompany      *usecase.CreateCompany
	getCompany         *usecase.GetCompany
	listCompanies      *usecase.ListCompanies
	validateTenant     *usecase.ValidateTenant
	createDepartment   *usecase.CreateDepartment
	setUserDepartment  *usecase.SetUserDepartment
	getResolvedProfile ResolvedProfileGetter
	createTeam         *usecase.CreateTeam
	addTeamMember      *usecase.AddTeamMember
	listTeamMembers    *usecase.ListTeamMembers
	getUserProfile     *usecase.GetUserProfile
	listDepartments    *usecase.ListDepartments
	updateCompany      *usecase.UpdateCompany
	updateDepartment   *usecase.UpdateDepartment
	updateUserProfile  *usecase.UpdateUserProfile
	listTeams          *usecase.ListTeams
	removeTeamMember   *usecase.RemoveTeamMember
	getOnboardingState *usecase.GetOnboardingState
	setOnboardingState *usecase.SetOnboardingState

	addCompanyEmailDomain       *usecase.AddCompanyEmailDomain
	removeCompanyEmailDomain    *usecase.RemoveCompanyEmailDomain
	listCompanyEmailDomains     *usecase.ListCompanyEmailDomains
	resolveCompanyByEmailDomain *usecase.ResolveCompanyByEmailDomain
}
```

Add one field, right after `listTeams` (keeps it grouped with the Teams RPCs):

```go
	listTeams          *usecase.ListTeams
	listTeamsForUser   *usecase.ListTeamsForUser
	removeTeamMember   *usecase.RemoveTeamMember
```

Current `New()` (`server.go:58-101`, parameter list + body) — add
`listTeamsForUser *usecase.ListTeamsForUser` as a parameter right after
`listTeams *usecase.ListTeams`, and `listTeamsForUser: listTeamsForUser,` in
the returned struct literal right after `listTeams: listTeams,`. Every
existing call site of `grpc.New(...)` (there's exactly one, in `main.go`,
Step 3 below) must add the new argument in the same position or the build
fails on argument-count mismatch — there's no other caller.

Add the RPC method, right after `ListTeamMembers` (current code at
`server.go:248-258`):

```go
func (s *Server) ListTeamMembers(ctx context.Context, req *tenantv1.ListTeamMembersRequest) (*tenantv1.ListTeamMembersResponse, error) {
	members, err := s.listTeamMembers.Execute(ctx, usecase.ListTeamMembersInput{TeamID: req.GetTeamId()})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	out := make([]*tenantv1.TeamMember, 0, len(members))
	for _, m := range members {
		out = append(out, &tenantv1.TeamMember{UserId: m.UserID, Priority: m.Priority})
	}
	return &tenantv1.ListTeamMembersResponse{Members: out}, nil
}
```

Insert immediately after it:

```go
func (s *Server) ListTeamsForUser(ctx context.Context, req *tenantv1.ListTeamsForUserRequest) (*tenantv1.ListTeamsForUserResponse, error) {
	teamIDs, err := s.listTeamsForUser.Execute(ctx, usecase.ListTeamsForUserInput{UserID: req.GetUserId()})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &tenantv1.ListTeamsForUserResponse{TeamIds: teamIDs}, nil
}
```

### Step 3 — wire it in `main.go`'s composition root

Current code (`backend-go/services/tenant-service/cmd/server/main.go:140`,
plus the surrounding `grpc.New(...)` call at `:150-174`):

```go
	listTeamsUC := usecase.NewListTeams(teams)
```

Add right after it:

```go
	listTeamsUC := usecase.NewListTeams(teams)
	listTeamsForUserUC := usecase.NewListTeamsForUser(teams)
```

Current code (`main.go:150-174`):

```go
	tenantv1.RegisterTenantServiceServer(grpcServer, tenantgrpc.New(
		createCompanyUC,
		getCompanyUC,
		listCompaniesUC,
		validateTenantUC,
		createDepartmentUC,
		setUserDepartmentUC,
		getResolvedProfileUC,
		createTeamUC,
		addTeamMemberUC,
		listTeamMembersUC,
		getUserProfileUC,
		listDepartmentsUC,
		updateCompanyUC,
		updateDepartmentUC,
		updateUserProfileUC,
		listTeamsUC,
		removeTeamMemberUC,
		getOnboardingStateUC,
		setOnboardingStateUC,
		addCompanyEmailDomainUC,
		removeCompanyEmailDomainUC,
		listCompanyEmailDomainsUC,
		resolveCompanyByEmailDomainUC,
	))
```

Add `listTeamsForUserUC` right after `listTeamsUC` (matching the parameter
position added to `New()` in Step 2):

```go
		listTeamsUC,
		listTeamsForUserUC,
		removeTeamMemberUC,
```

## Verify

```bash
cd /opt/repos/orca/backend-go
go build ./services/tenant-service/...
go vet ./services/tenant-service/...
gofmt -l services/tenant-service/internal/usecase/list_teams_for_user.go services/tenant-service/internal/adapter/grpc/server.go services/tenant-service/cmd/server/main.go
go test ./services/tenant-service/internal/adapter/grpc/... -count=1
```

Expected: clean build (proves the new `Server` field/constructor argument/
method line up positionally with no mismatch), no gofmt diffs, no existing
gRPC-adapter test broken. TASK-042 adds this usecase's own unit tests.
