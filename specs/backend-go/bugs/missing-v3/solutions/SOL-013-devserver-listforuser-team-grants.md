# SOL-013: Add `tenant-service.ListTeamsForUser` and populate `TeamIds` in `devServer.listForUser`

**Resolves:** [BUG-013](../BUG-013-devserver-listforuser-team-grants-ignored.md)
**Service:** `tenant-service` (new RPC) + `api-gateway` (`wscompat` wiring)
**Affected files (proposed):**
- `backend-go/proto/orca/tenant/v1/tenant.proto` (new `ListTeamsForUser` RPC + 2 messages)
- `backend-go/services/tenant-service/internal/usecase/list_teams_for_user.go` (new)
- `backend-go/services/tenant-service/internal/usecase/list_teams_for_user_test.go` (new)
- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_dev_server_access_control.go:275-306` (`devServer.listForUser` handler)
- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_dev_server_access_control_test.go` (or wherever this channel's existing test lives — extend for the team-grant case)
- `specs/backend-go/tdd/services/tenant-service.md:79-85` (extend the already-sketched API surface with the new RPC — this design doesn't exist there yet, see below)
**Status:** 🚧 Proposed — no code written

---

## Root cause, confirmed

BUG-013's own diagnosis is correct and this solution doesn't need to
re-litigate it: `channels_dev_server_access_control.go:297` builds
`ListDevServersForUserRequest{DepartmentId: departmentID}` and never sets
`TeamIds`, because `tenant-service` has no RPC that answers "which teams is
this user in" — only `ListTeams(company_id)` (all teams) and
`ListTeamMembers(team_id)` (members of one team), which the handler's own
doc comment (`channels_dev_server_access_control.go:279-284`) correctly
refuses to fan out over N+1-style.

What BUG-013 did **not** need to check, and this solution did (task step 4
below): whether the fix is only a producer-side gap, or whether the
consumer (`infra-fleet-service.ListDevServersForUser`) also has work to do.
It doesn't — see "Consumer-side verification" below. This is a pure
plumbing fix: one new tenant-service RPC, wired into one existing handler.

## The repository query this RPC needs already exists

`TeamRepository.ListUserTeamLayers(ctx, companyID, userID) ([]domain.TeamSettingsLayer, error)`
(`backend-go/services/tenant-service/internal/adapter/postgres/team_repository.go:148-177`)
already runs exactly the join this bug needs:

```sql
SELECT t.id, t.settings_json, tm.priority
FROM tenant.team_members tm
JOIN tenant.teams t ON t.id = tm.team_id
WHERE tm.user_id = $1 AND t.company_id = $2
```

This is not new capability — it's the query `GetResolvedProfile`
(`backend-go/services/tenant-service/internal/usecase/get_resolved_profile.go:64-67`)
already runs on every profile-resolution call (`tenant-service.md` §6's hot
path) to build the team settings-layer for the 4-layer merge. It is backed
by a real index, not a table scan:
`idx_team_members_user(user_id)` — declared at
`backend-go/services/tenant-service/migrations/0001_init.up.sql:77` and
documented in `tenant-service.md`'s data-model table (§5, line 164). Company
scoping happens via the join to `tenant.teams.company_id`, matching
`tenant-service.md` §9's "never inferred from a nested resource ID,
always the validated request-context tenant" rule the same way
`ListUserTeamLayers` already scopes it for `GetResolvedProfile`.

**Consequence for the design below: no new repository method, no new SQL,
no new index.** `TeamRepository.ListUserTeamLayers` already returns
`domain.TeamSettingsLayer{TeamID, Priority, Settings}` per row — the new
usecase only needs to project `TeamID` out of the slice it already gets.
This is the same "thin, the port already exists" shape as
`GetUserProfile` (`specs/backend-go/bugs/missing-v1/solutions/SOL-019-profile-channels.md`'s
own example of that pattern, itself unwrapping `UserProfileRepository.Get`).

## Design — proto (`tenant.proto`)

`tenant-service.md` §3's own API-surface sketch (lines 79-85) lists the
Teams RPC group as `CreateTeam`/`UpdateTeam`/`ListTeams`/`AddTeamMember`/
`RemoveTeamMember`/`ListTeamMembers` — **it does not sketch a user-scoped
team query today.** Unlike SOL-019 (which implemented RPCs the TDD had
already specified), this solution has to extend the target design, not
just close a gap against it. The addition is additive to both the actual
proto and the TDD sketch:

```protobuf
// ListTeamsForUser answers "which teams is this user a member of" without
// the ListTeams(company)+ListTeamMembers(team) N+1 fan-out
// devServer.listForUser's handler doc comment deliberately avoids — added
// to unblock team-based dev-server access grants (CR-DS-007 §3's recorded
// "Known gap ghi nhận khi triển khai").
rpc ListTeamsForUser(ListTeamsForUserRequest) returns (ListTeamsForUserResponse);

message ListTeamsForUserRequest {
  string user_id = 1;
  // company_id intentionally omitted — same pattern as ListTeamsRequest/
  // AddTeamMemberRequest: the scoping company comes from the validated
  // request context (tenant.RequireTenantID), never a client-supplied
  // field, per tenant-service.md §9.
}

message ListTeamsForUserResponse {
  repeated string team_ids = 1;
}
```

Kept deliberately thin (`team_ids` only, not full `Team` messages) because
the one real caller — `devServer.listForUser` — only needs IDs to populate
`infrafleetv1.ListDevServersForUserRequest.TeamIds` (`repeated string`,
`backend-go/proto/orca/infrafleet/v1/infrafleet.proto:370`); returning full
`Team` objects would mean the client discards `name`/`settings_json` on
every call. Additive-only change — no `buf breaking` risk
(`08-inter-service-communication.md`'s gRPC conventions), same posture
SOL-019 already established for this proto file.

**`tenant-service.md` update**: insert `rpc ListTeamsForUser(...)` into the
sketch at line 85 (immediately after `ListTeamMembers`, same "Teams" group,
comment noting it exists to serve `devServer.listForUser`'s team-grant
lookup rather than any team-admin UI need — the RPC's only current caller is
cross-service, not the Team CRUD console flows the rest of the group backs).

## Design — `usecase/` layer

```go
// internal/usecase/list_teams_for_user.go
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
// (channels_dev_server_access_control.go:279-284). Thin: reuses
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

No `ports.go` change: `TeamRepository.ListUserTeamLayers` is already on the
port (`internal/usecase/ports.go:126-130`), added for `GetResolvedProfile`.
A user with zero team memberships gets `layers == nil`, so `teamIDs` comes
back as an empty (non-nil, len-0) slice — mirrors `ListTeams.Execute`'s own
"no rows is not an error" posture (`list_teams.go:20-30`), not a
not-found error; there is no such thing as an invalid `user_id` at this
layer (unlike `ListTeamMembers`, which 404s an unknown `team_id` — this
call intentionally never validates the user exists, since a user with no
`tenant.team_members` rows and a user who doesn't exist look identical from
this query and both correctly resolve to "no teams").

## Design — `wscompat` wiring (`channels_dev_server_access_control.go`)

Replace the `Known gap` doc comment and add one more tenant-service round
trip alongside the existing `GetUserProfile` call, before building the
fleet request:

```go
// devServer.listForUser — NOT admin-gated. Resolves the caller's
// department via tenant-service.GetUserProfile and the caller's team
// memberships via tenant-service.ListTeamsForUser (both real RPCs), then
// calls infra-fleet-service.ListDevServersForUser with both populated.
r.Register("devServer.listForUser", func(ctx context.Context, id Identity, _ []json.RawMessage) (any, error) {
	gwCtx := gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
	rpcCtx, cancel := context.WithTimeout(gwCtx, rpcTimeout)
	defer cancel()
	profileResp, err := tenantClient.GetUserProfile(rpcCtx, &tenantv1.GetUserProfileRequest{UserId: id.UserID})
	if err != nil {
		return nil, err
	}
	departmentID := profileResp.GetProfile().GetDepartmentId()

	teamsRpcCtx, teamsCancel := context.WithTimeout(gwCtx, rpcTimeout)
	defer teamsCancel()
	teamsResp, err := tenantClient.ListTeamsForUser(teamsRpcCtx, &tenantv1.ListTeamsForUserRequest{UserId: id.UserID})
	if err != nil {
		return nil, err
	}

	fleetRpcCtx, fleetCancel := context.WithTimeout(gwCtx, rpcTimeout)
	defer fleetCancel()
	resp, err := client.ListDevServersForUser(fleetRpcCtx, &infrafleetv1.ListDevServersForUserRequest{
		DepartmentId: departmentID,
		TeamIds:      teamsResp.GetTeamIds(),
	})
	if err != nil {
		return nil, err
	}
	views := make([]devServerView, 0, len(resp.GetDevServers()))
	for _, ds := range resp.GetDevServers() {
		views = append(views, attachConnectionStatus(gwCtx, client, toDevServerView(ds)))
	}
	return map[string]any{"devServers": views}, nil
})
```

**Failure mode, chosen deliberately, flagged for reviewer confirmation**:
a `ListTeamsForUser` RPC error fails the whole `devServer.listForUser` call
(same as a `GetUserProfile` error already does today), rather than
degrading to department-only silently. This trades "one flaky call breaks
the whole picker" for "never silently under-provision a team-granted
user" — the exact silent-gap complaint BUG-013 raised. The alternative
(swallow the error, log, continue with `TeamIds: nil`) would reproduce
today's bug under a new trigger (tenant-service transient failure) instead
of fixing it, so it isn't proposed here.

No change to `registerDevServerAccessControlChannels`'s signature —
`tenantClient tenantv1.TenantServiceClient` is already a parameter
(`channels_dev_server_access_control.go:126`), so the new RPC method
becomes callable as soon as the client is regenerated from the updated
proto; no new wiring in `main.go`'s composition root.

## Consumer-side verification (task step 4) — already correct, no changes needed

BUG-013 only diagnosed the producer (`channels_dev_server_access_control.go`).
Checked independently here: `infra-fleet-service`'s
`ListDevServersForUser` usecase
(`backend-go/services/infra-fleet-service/internal/usecase/list_dev_servers_for_user.go:50-131`)
already handles a populated `TeamIds` correctly and has direct test
coverage proving it:

- `Execute` builds a `teamSet` from `in.TeamIDs`
  (`list_dev_servers_for_user.go:77-80`) and its `groupGrantsAccess`
  closure matches a grant via `grant.GranteeKind == domain.GranteeKindTeam
  && teamSet[grant.GranteeID]` (`:101`) — OR'd with the department check
  (`:97-100`), exactly CR-DS-007 §3 decision 3 ("Department vs Team xung
  đột → OR (1 trong 2 đủ)").
- `TestListDevServersForUser_TeamGrantMatches`
  (`list_dev_servers_for_user_test.go:100-118`) already exercises
  `ListDevServersForUserInput{TeamIDs: []string{"team1", "team2"}}` against
  a team-kind grant and asserts the match — this test already passes today,
  proving the consumer logic was never the gap.
- The ancestor-inheritance walk (`groupGrantsAccess`'s parent-chain
  recursion, `:106-112`) applies identically regardless of which grant kind
  matched, so a team grant on a parent group already inherits down to child
  groups the same way `TestListDevServersForUser_InheritsGrantFromParentGroup`
  proves for department grants — no separate team-specific inheritance test
  exists, but the code path is grant-kind-agnostic, not a department-only
  special case.
- The proto's own doc comment
  (`backend-go/proto/orca/infrafleet/v1/infrafleet.proto:359-367`) already
  states `department_id`/`team_ids` are "supplied by the caller... having
  already resolved them via tenant-service" — worth noting precisely
  because it's slightly aspirational as written today: it names
  `tenant-service.GetResolvedProfile` as that resolution step, but
  `GetResolvedProfile` returns only merged `Settings` + a `Sources`
  dot-path map (`domain.ResolvedProfile`,
  `internal/domain/profile_resolution.go:44-50`) — no raw `department_id`
  or `team_ids` fields to read back out. The real handler today (and this
  solution's fix) instead calls `GetUserProfile` for the department and the
  new `ListTeamsForUser` for teams — two lighter, purpose-built reads
  rather than parsing `ResolvedProfile.Sources`' `"team:<id>"` labels
  (`domain.TeamSource`, `profile_resolution.go:29-32`), which would be
  fragile (string-typed, and only populated for keys a team layer actually
  won). Not a defect to fix here — just a doc-comment precision gap worth
  flagging to whoever touches that proto file next, since this solution
  does not propose editing infra-fleet-service's proto or usecase at all.

**Verdict for task step 4: the consumer was already correct.** This is a
pure producer/wiring fix, confirming BUG-013's own "Fix direction" framing
was accurately scoped and didn't need to be broadened.

## Test plan

- `services/tenant-service/internal/usecase/list_teams_for_user_test.go`
  (new), mirroring `list_teams_test.go`'s shape:
  - `TestListTeamsForUser_RequiresTenantContext` — no tenant in context → error.
  - `TestListTeamsForUser_ReturnsTeamIDs` — user in 2 teams within the
    caller's company → both IDs returned.
  - `TestListTeamsForUser_ScopesByCompany` — a team membership belonging to
    a different `company_id` must never appear (same cross-company
    assertion `TestListTeams_ScopesByCompany` already makes for `ListTeams`).
  - `TestListTeamsForUser_NoMemberships` — user with zero rows in
    `tenant.team_members` → `[]string{}`, no error (not a 404).
- `services/tenant-service/internal/adapter/postgres/repository_test.go` —
  no new case needed; `ListUserTeamLayers` is exercised there already (it's
  reused, not new).
- `services/api-gateway/internal/adapter/wscompat` — extend
  `devServer.listForUser`'s existing test (or add one) with a fake
  `TenantServiceClient` returning a non-empty `ListTeamsForUserResponse`,
  asserting the built `ListDevServersForUserRequest.TeamIds` matches it —
  this is the actual regression BUG-013 describes (`team_ids` observed
  always empty) and is the one assertion that would have caught it.
- `services/infra-fleet-service` — no new tests proposed; existing
  `TestListDevServersForUser_TeamGrantMatches` and
  `TestListDevServersForUser_InheritsGrantFromParentGroup` already cover
  the consumer side per the verification above.

## References

- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_dev_server_access_control.go:126,275-306` — `devServer.listForUser` handler and its doc comment
- `backend-go/services/tenant-service/internal/adapter/postgres/team_repository.go:148-177` — `ListUserTeamLayers`, the reused query
- `backend-go/services/tenant-service/internal/usecase/ports.go:111-131` — `TeamRepository` port (`ListUserTeamLayers` already declared)
- `backend-go/services/tenant-service/internal/usecase/get_resolved_profile.go:64-67` — the existing caller of `ListUserTeamLayers`
- `backend-go/services/tenant-service/internal/usecase/get_user_profile.go`, `list_teams.go` — the "thin, port already exists" precedent this solution's usecase mirrors
- `backend-go/services/tenant-service/migrations/0001_init.up.sql:68-84` — `tenant.team_members` schema + `idx_team_members_user`
- `specs/backend-go/tdd/services/tenant-service.md:55-86` (§3), `:152-180` (§5, data model + index) — target API surface and schema this solution extends
- `backend-go/proto/orca/tenant/v1/tenant.proto:11-64` (service list), `:158-169` (`ListTeamMembers*` messages this solution's new messages sit next to)
- `backend-go/proto/orca/infrafleet/v1/infrafleet.proto:359-377` — `ListDevServersForUserRequest/Response`, including the doc comment discussed above
- `backend-go/services/infra-fleet-service/internal/usecase/list_dev_servers_for_user.go:11-131` — consumer usecase, verified already-correct
- `backend-go/services/infra-fleet-service/internal/usecase/list_dev_servers_for_user_test.go:100-118` — `TestListDevServersForUser_TeamGrantMatches`, the existing proof
- `docs/crs/v2/dev-server/CR-DS-007-department-based-access-control.md` §3 decision 3, "Known gap ghi nhận khi triển khai" (final paragraph) — the design doc's own record of this gap
- `specs/backend-go/bugs/missing-v1/solutions/SOL-019-profile-channels.md` — house-style precedent for a "thin usecase, port already exists" RPC addition
