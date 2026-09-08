# TASK-039: Add `tenant-service.ListTeamsForUser` RPC + messages to `tenant.proto`

**From Solution:** SOL-013 (Design — proto `tenant.proto`)
**Priority:** P0 — first; every other task in this set needs the generated
Go types this task produces
**Service:** `tenant-service`
**File:** `backend-go/proto/orca/tenant/v1/tenant.proto`, `specs/backend-go/tdd/services/tenant-service.md`
**Depends on:** none
**Status:** `[x]` DONE — as specified. `buf breaking` needed `subdir=backend-go/proto` appended to the `.git#branch=main` ref (the repo root is `/opt/repos/orca`, not the proto dir) to actually compare instead of silently no-op'ing; otherwise matched the sketch exactly. `buf lint` shows only pre-existing warnings in unrelated files (issuetracking/notification/scmintegration/task/tenant's older RPCs) — none on the new `ListTeamsForUser` RPC/messages. `go build ./proto/...` clean; generated files under `proto/gen/go/orca/tenant/v1/` now contain `ListTeamsForUserRequest`, `ListTeamsForUserResponse`, and `ListTeamsForUser` on both client and server interfaces.

---

## Context

BUG-013's root cause is that `tenant-service` has no RPC to answer "which
teams is this user a member of" — only `ListTeams(company_id)` (all teams)
and `ListTeamMembers(team_id)` (members of one team), which would require an
N+1 fan-out the `devServer.listForUser` handler deliberately refuses to do
(`channels_dev_server_access_control.go:279-284`). SOL-013 adds a thin,
purpose-built `ListTeamsForUser(user_id)` RPC returning only `team_ids`, kept
minimal because the one real caller only needs IDs to populate
`infrafleetv1.ListDevServersForUserRequest.TeamIds`. This task is the
additive-only proto change; no service/usecase code changes here.

## Changes to make

### Step 1 — add the RPC to the `TenantService` service block

Current code (`backend-go/proto/orca/tenant/v1/tenant.proto:27-29`):

```protobuf
  rpc CreateTeam(CreateTeamRequest) returns (CreateTeamResponse);
  rpc AddTeamMember(AddTeamMemberRequest) returns (AddTeamMemberResponse);
  rpc ListTeamMembers(ListTeamMembersRequest) returns (ListTeamMembersResponse);
```

Replace with:

```protobuf
  rpc CreateTeam(CreateTeamRequest) returns (CreateTeamResponse);
  rpc AddTeamMember(AddTeamMemberRequest) returns (AddTeamMemberResponse);
  rpc ListTeamMembers(ListTeamMembersRequest) returns (ListTeamMembersResponse);
  // ListTeamsForUser answers "which teams is this user a member of" without
  // the ListTeams(company)+ListTeamMembers(team) N+1 fan-out
  // devServer.listForUser's handler doc comment deliberately avoids — added
  // to unblock team-based dev-server access grants (BUG-013,
  // CR-DS-007 §3's recorded "Known gap ghi nhận khi triển khai").
  rpc ListTeamsForUser(ListTeamsForUserRequest) returns (ListTeamsForUserResponse);
```

### Step 2 — add the two new messages

Current code (`backend-go/proto/orca/tenant/v1/tenant.proto:158-169`):

```protobuf
message ListTeamMembersRequest {
  string team_id = 1;
}

message TeamMember {
  string user_id = 1;
  int32 priority = 2;
}

message ListTeamMembersResponse {
  repeated TeamMember members = 1;
}
```

Replace with (adds two new messages after `ListTeamMembersResponse`, changes
nothing else in this block):

```protobuf
message ListTeamMembersRequest {
  string team_id = 1;
}

message TeamMember {
  string user_id = 1;
  int32 priority = 2;
}

message ListTeamMembersResponse {
  repeated TeamMember members = 1;
}

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

### Step 3 — extend the TDD sketch (`tenant-service.md`)

Current code (`specs/backend-go/tdd/services/tenant-service.md:79-86`, the
"Teams" group of §3's API-surface sketch):

```protobuf
  // Teams
  rpc CreateTeam(CreateTeamRequest) returns (Team);
  rpc UpdateTeam(UpdateTeamRequest) returns (Team);
  rpc ListTeams(ListTeamsRequest) returns (ListTeamsResponse);
  rpc AddTeamMember(AddTeamMemberRequest) returns (TeamMembership);   // upsert: role + priority
  rpc RemoveTeamMember(RemoveTeamMemberRequest) returns (google.protobuf.Empty);
  rpc ListTeamMembers(ListTeamMembersRequest) returns (ListTeamMembersResponse);
}
```

Replace with:

```protobuf
  // Teams
  rpc CreateTeam(CreateTeamRequest) returns (Team);
  rpc UpdateTeam(UpdateTeamRequest) returns (Team);
  rpc ListTeams(ListTeamsRequest) returns (ListTeamsResponse);
  rpc AddTeamMember(AddTeamMemberRequest) returns (TeamMembership);   // upsert: role + priority
  rpc RemoveTeamMember(RemoveTeamMemberRequest) returns (google.protobuf.Empty);
  rpc ListTeamMembers(ListTeamMembersRequest) returns (ListTeamMembersResponse);
  // ListTeamsForUser — added for devServer.listForUser's team-grant lookup
  // (BUG-013), not any team-admin UI need. The only current caller is
  // cross-service (api-gateway's wscompat), not the Team CRUD console flows
  // the rest of this group backs.
  rpc ListTeamsForUser(ListTeamsForUserRequest) returns (ListTeamsForUserResponse);
}
```

### Step 4 — regenerate Go code

Run `buf generate` (see Verify below). This produces
`ListTeamsForUserRequest`/`ListTeamsForUserResponse` Go types and adds
`ListTeamsForUser` to the generated `tenantv1.TenantServiceClient` /
`TenantServiceServer` interfaces under
`backend-go/proto/gen/go/orca/tenant/v1/` — do not hand-edit generated files.

## Verify

```bash
cd /opt/repos/orca/backend-go/proto
buf lint
buf breaking --against '.git#branch=main' || true   # matches Makefile's `proto-lint` target; expect clean (additive-only change)
buf generate                                          # matches Makefile's `proto-gen` target
cd /opt/repos/orca/backend-go
go build ./proto/...
git status --short proto/gen/go/orca/tenant/v1/         # confirm generated files changed and are staged for commit
```

Expected: `buf breaking` reports no breaking changes (pure addition), the
generated Go files under `proto/gen/go/orca/tenant/v1/` now contain
`ListTeamsForUserRequest`, `ListTeamsForUserResponse`, and a
`ListTeamsForUser` method on both the client and server interfaces, and
`go build ./proto/...` is clean.
