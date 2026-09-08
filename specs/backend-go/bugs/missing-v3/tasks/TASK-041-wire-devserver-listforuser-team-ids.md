# TASK-041: Populate `TeamIds` in `devServer.listForUser` via the new `ListTeamsForUser` RPC

**From Solution:** SOL-013 (Design — `wscompat` wiring)
**Priority:** P1 — the actual bug fix; needs TASK-040's generated client method to compile
**Service:** `api-gateway`
**File:** `backend-go/services/api-gateway/internal/adapter/wscompat/channels_dev_server_access_control.go`
**Depends on:** TASK-039, TASK-040
**Status:** `[x]` DONE — as specified, with one addition beyond the task's own scope: `go vet ./services/api-gateway/...` also failed to compile `internal/adapter/httpgateway/tenant_routes_test.go`'s separate, non-embedding `fakeTenantServiceClient` (a different type from wscompat's, same name, in a different package) because it fully implements `tenantv1.TenantServiceClient` with no embedded interface — added a `ListTeamsForUser` stub there returning `codes.Unimplemented`, matching that file's own existing pattern for `ListTeams`/`RemoveTeamMember` ("not used by tenant_routes_test.go"), so `go vet ./services/api-gateway/...` is clean. `go build`/`gofmt` clean. `go test -run TestDevServer` in wscompat panics on a nil-func deref exactly as TASK-041's own Verify section predicted (`fakeTenantServiceClient.ListTeamsForUser` calls `f.listTeamsForUserFunc` which the existing test never sets) — expected and left for TASK-042 to fix, not treated as this task's failure.

---

## Context

BUG-013: `channels_dev_server_access_control.go:297` builds
`ListDevServersForUserRequest{DepartmentId: departmentID}` and never sets
`TeamIds`, so team-based dev-server access grants (a real, admin-creatable
state — `devServerGroup.grant` at `:217-239` explicitly supports a `"team"`
grantee) can never match for any user. This task adds one more
tenant-service round trip — `ListTeamsForUser`, added in TASK-039/TASK-040 —
alongside the existing `GetUserProfile` call, and threads its result into
the downstream request. The consumer side
(`infra-fleet-service.ListDevServersForUser`) needs no changes — see
"Consumer-side verification, already done" in TASK-042's Context.

## Changes to make

Current code (`channels_dev_server_access_control.go:275-306`):

```go
	// devServer.listForUser — NOT admin-gated. Resolves the caller's
	// department via tenant-service.GetUserProfile (a real, existing RPC),
	// then calls infra-fleet-service.ListDevServersForUser.
	//
	// Known gap: team_ids is always empty here — tenant-service has no
	// "list teams for user" RPC today (only ListTeams(company_id) and
	// ListTeamMembers(team_id), an N+1 pattern this handler deliberately
	// does not do). Department-based grants work correctly; team-based
	// grants won't match anything until that follow-up RPC exists. See
	// docs/crs/v2/dev-server/CR-DS-007-department-based-access-control.md.
	r.Register("devServer.listForUser", func(ctx context.Context, id Identity, _ []json.RawMessage) (any, error) {
		gwCtx := gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(gwCtx, rpcTimeout)
		defer cancel()
		profileResp, err := tenantClient.GetUserProfile(rpcCtx, &tenantv1.GetUserProfileRequest{UserId: id.UserID})
		if err != nil {
			return nil, err
		}
		departmentID := profileResp.GetProfile().GetDepartmentId()

		fleetRpcCtx, fleetCancel := context.WithTimeout(gwCtx, rpcTimeout)
		defer fleetCancel()
		resp, err := client.ListDevServersForUser(fleetRpcCtx, &infrafleetv1.ListDevServersForUserRequest{DepartmentId: departmentID})
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

Replace with:

```go
	// devServer.listForUser — NOT admin-gated. Resolves the caller's
	// department via tenant-service.GetUserProfile and the caller's team
	// memberships via tenant-service.ListTeamsForUser (both real RPCs), then
	// calls infra-fleet-service.ListDevServersForUser with both populated.
	// BUG-013's fix: team_ids used to always be empty here because
	// tenant-service had no "list teams for user" RPC (see git blame on this
	// comment for the old doc comment describing that gap).
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

**Failure mode, chosen deliberately (per SOL-013), flag for reviewer
confirmation**: a `ListTeamsForUser` RPC error fails the whole
`devServer.listForUser` call, same as a `GetUserProfile` error already does
today, rather than degrading to department-only silently. This trades "one
flaky call breaks the whole picker" for "never silently under-provision a
team-granted user" — the exact silent-gap complaint BUG-013 raised. The
alternative (swallow the error, log, continue with `TeamIds: nil`) would
reproduce today's bug under a new trigger (a transient tenant-service
failure) instead of fixing it.

No change to `registerDevServerAccessControlChannels`'s signature —
`tenantClient tenantv1.TenantServiceClient` is already a parameter
(`channels_dev_server_access_control.go:126`), so the new RPC method becomes
callable as soon as TASK-039/TASK-040 regenerate/implement it; no new wiring
in `cmd/server/main.go` for `api-gateway` (the client is already injected).

## Verify

```bash
cd /opt/repos/orca/backend-go
go build ./services/api-gateway/...
go vet ./services/api-gateway/...
gofmt -l services/api-gateway/internal/adapter/wscompat/channels_dev_server_access_control.go
go test ./services/api-gateway/internal/adapter/wscompat/... -run TestDevServer -count=1 -v
```

Expected: clean build; the existing
`TestDevServerListForUserChannel_ResolvesDepartmentThenLists` test will
currently fail to compile/pass until the test fake is updated — that update
is TASK-042's job, not this task's. If this task is run standalone before
TASK-042, expect a compile error in `channels_dev_server_access_control_test.go`
(the fake's embedded nil `tenantv1.TenantServiceClient` technically still
satisfies the interface, so it *compiles*, but the existing test's fake
never sets `listTeamsForUserFunc`, so calling `ListTeamsForUser` on the fake
panics on a nil-func deref at runtime) — this is expected and resolved by
TASK-042's test-fake update, not a sign this task's change is wrong.
