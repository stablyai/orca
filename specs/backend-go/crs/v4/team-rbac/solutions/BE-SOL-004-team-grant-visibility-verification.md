# BE-SOL-004: Team-grant dev-server visibility — verified already fixed (BUG-013); close the paper gap only

> **🔲 Proposed — not implemented** (in the narrow sense below: the only
> remaining action is a small doc/comment/test cleanup — see §3). No
> production code has been changed as part of writing this document.

**CR:** [CR-RBAC-004](../../../../../../docs/crs/v4/team-rbac/CR-RBAC-004-project-team-scoped-server-visibility.md)
**Service:** api-gateway (wscompat) + tenant-service + infra-fleet-service (verification only)
**Depends on:** none.

---

## 1. What the CR asked to verify

> "RPC nội bộ `ListTeamsForUser` đã tồn tại ở tenant-service theo audit trước
> — kiểm tra lại tại sao `infra-fleet-service` chưa gọi được nó, có thể chỉ
> thiếu client wiring, không phải thiếu RPC thật."

## 2. Verified: this is already fixed end-to-end, under a prior bug fix labeled BUG-013

This is the headline finding of this pass, and it **contradicts** the
frontend comment the CR's own evidence cites
(`frontend/.../AdminDevServerConsole.tsx:349-352`: *"tenant-service has no
'list teams for a user' RPC, so ListDevServersForUser's team_ids is always
empty server-side too (documented gap, BE-SOL-003)"*). That comment is now
**stale** — verified by reading the two real call sites directly:

**`backend-go/services/api-gateway/internal/adapter/wscompat/channels_dev_server_access_control.go:275-313`**
(`devServer.listForUser` channel):

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
	if err != nil { return nil, err }
	departmentID := profileResp.GetProfile().GetDepartmentId()

	teamsRpcCtx, teamsCancel := context.WithTimeout(gwCtx, rpcTimeout)
	defer teamsCancel()
	teamsResp, err := tenantClient.ListTeamsForUser(teamsRpcCtx, &tenantv1.ListTeamsForUserRequest{UserId: id.UserID})
	if err != nil { return nil, err }

	fleetRpcCtx, fleetCancel := context.WithTimeout(gwCtx, rpcTimeout)
	defer fleetCancel()
	resp, err := client.ListDevServersForUser(fleetRpcCtx, &infrafleetv1.ListDevServersForUserRequest{
		DepartmentId: departmentID,
		TeamIds:      teamsResp.GetTeamIds(),
	})
	// ...
})
```

**`backend-go/services/api-gateway/internal/adapter/wscompat/channels_onboarding.go:388-419`**
(`onboardingDetectAgentsAllServers`, used by the onboarding agent-detection
fan-out) does the identical `GetUserProfile` → `ListTeamsForUser` →
`ListDevServersForUser(TeamIds: ...)` sequence, with its own doc comment
explicitly citing BUG-013 as the reason `TeamIds` is resolved here too
("omitting TeamIds here would make this fan-out see a narrower dev-server
set than the caller's own `devServer.listForUser` view").

And the consuming usecase already implements the team-grant branch
correctly and has dedicated test coverage:
`backend-go/services/infra-fleet-service/internal/usecase/list_dev_servers_for_user.go:96-104`
checks `grant.GranteeKind == domain.GranteeKindTeam && teamSet[grant.GranteeID]`
in the same ancestor-walk as the department branch, and
`TestListDevServersForUser_TeamGrantMatches` (referenced by
`codegraph_explore`'s call-graph scan of this file) already exists to cover
it.

**Conclusion for CR-RBAC-004's central question**: it was **client wiring**,
not a missing RPC — and the wiring gap is already closed. `tenant-service`'s
`ListTeamsForUser` RPC (`tenant-service/internal/adapter/grpc/server.go:496-502`)
is real, backed by `usecase.ListTeamsForUser` (not a stub), and both
api-gateway call sites that feed `infra-fleet-service.ListDevServersForUser`
already call it and forward `TeamIds`.

## 3. What's actually left to do (small)

Since the backend-go mechanism is done, this solution is a verification +
cleanup pass, not a feature build:

1. **Update the stale frontend comment** at `AdminDevServerConsole.tsx:349-352`
   (and the `GroupsAndGrantsTab` UI it documents, which still only offers a
   department picker for grants) — `frontend/` change, listed here for
   completeness but out of scope for a backend-go-only solution set; flag it
   to whoever picks up CR-RBAC-001's frontend cutover.
2. **Confirm test coverage reaches the wscompat layer, not just the usecase.**
   `TestListDevServersForUser_TeamGrantMatches` proves the *usecase* branch
   works; verify (and add if missing) a `channels_dev_server_access_control_test.go`
   case asserting `devServer.listForUser` actually forwards
   `teamsResp.GetTeamIds()` into the `ListDevServersForUserRequest` it sends
   to `infra-fleet-service` — i.e. a wiring-level regression test, the same
   shape as `channels_workflow_test.go`'s
   `TestWorkflowExecuteAdHocStepChannel_TenantIDComesFromIdentityNotArgs`
   pattern (assert on the *fake client's received request*, not just the
   final response). This is the one gap actually worth closing: nothing
   currently proves the wscompat→infra-fleet-service wiring won't regress
   silently if someone refactors `channels_dev_server_access_control.go`
   again.
3. **`ListTeamsForUser` error handling is fail-closed, confirm that's
   intentional.** Both call sites `return nil, err` if `ListTeamsForUser`
   errors — meaning a `tenant-service` outage makes `devServer.listForUser`
   fail entirely rather than degrading to department-only visibility. This
   matches the codebase's general fail-closed posture (`common/policy.Evaluator`'s
   doc comment, `requireProjectAccess`'s doc comment) and is almost
   certainly correct, but worth a one-line code comment noting the choice
   was deliberate (fail closed on a partial-grants-resolution failure,
   rather than silently showing a caller fewer servers than they're actually
   entitled to) so a future reviewer doesn't "fix" it into a fail-open bug.
4. **Dead-code removal** (`selectSshTargetsForCurrentUser`, `OrcaUser.teams`/`projects`)
   is entirely `frontend/`, out of scope here — but per the CR's own
   instruction, `impact()` must be run immediately before that removal is
   attempted, by whoever does it (see §5 — not run in this pass since no
   removal is being proposed here).

## 4. Files to change

| File | Change |
|---|---|
| `backend-go/services/api-gateway/internal/adapter/wscompat/channels_dev_server_access_control_test.go` | Add (if missing) a wiring-level test asserting `TeamIds` flows from `ListTeamsForUser`'s response into `ListDevServersForUser`'s request |
| `backend-go/services/api-gateway/internal/adapter/wscompat/channels_dev_server_access_control.go` | One-line comment documenting the deliberate fail-closed choice on `ListTeamsForUser` error (§3.3) — no behavior change |
| `docs/features/F32-team-rbac.md` | Confirm/update the scoping-axis note per the CR's acceptance criteria (Team/Department, not Project) — this doc update is common to CR-RBAC-002 as well; do it once |
| *(frontend, out of scope)* `AdminDevServerConsole.tsx` | Update the stale "tenant-service has no list-teams RPC" comment; flag for CR-RBAC-001's cutover owner |

## 5. Out of scope

- Any backend-go code change to `ListDevServersForUser`, `ListTeamsForUser`,
  or the wscompat channels — verified correct as-is.
- Adding a "Project" scoping axis for server visibility — the CR's own
  "Không thuộc phạm vi" already rules this out; Team/Department
  (infra-fleet-service) is the chosen, implemented axis.
- Frontend dead-code removal (`selectSshTargetsForCurrentUser`, `OrcaUser.teams`/`projects`,
  `GroupsAndGrantsTab`'s missing team-grant UI control) — `frontend/` scope.

## 6. Tests

- New (if absent): `channels_dev_server_access_control_test.go` —
  `TestDevServerListForUserChannel_ForwardsTeamIdsFromListTeamsForUser`
  (fake `tenantClient.ListTeamsForUser` returns `["team-a","team-b"]`; assert
  the fake `infraFleetClient.ListDevServersForUser` call captured
  `TeamIds: ["team-a","team-b"]`).
- Confirm existing: `TestListDevServersForUser_TeamGrantMatches`,
  `TestListDevServersForUser_DirectDepartmentGrantMatches`,
  `TestListDevServersForUser_InheritsGrantFromParentGroup` (all referenced by
  `codegraph_explore`'s scan of `list_dev_servers_for_user.go` — run them to
  reconfirm they still pass, no code change expected to affect them).

## 7. Impact analysis (gitnexus)

| Symbol | Direction | Risk | Impacted | Note |
|---|---|---|---|---|
| `ListDevServersForUser` (usecase, `infra-fleet-service/internal/usecase/list_dev_servers_for_user.go:40`) | upstream | LOW | 3 (1 direct, 1 process `run` in `infra-fleet-service/cmd/server/main.go`) | Not modified by this solution — read-only verification. |
| `ListTeamsForUser` (`tenant-service/internal/adapter/grpc/server.go:496`) | upstream | LOW | 0 via `impact()`'s method-overload resolution (the tool disambiguated to the gRPC-generated method wrapper, not the 2 real wscompat call sites `codegraph_explore` found directly) | `codegraph_explore`'s call-graph is the authoritative evidence here — it found `ListTeamsForUser`'s 2 real callers (`channels_dev_server_access_control.go`, `channels_onboarding.go`) directly via source, which is why this CR's central question ("does anyone call it") is answered with certainty despite `impact()`'s 0 on this particular symbol resolution. |

No code is being changed by this solution beyond a test addition and a
comment — `detect_changes()` before commit should show only test-file and
comment diffs, no `usecase/`/`adapter/grpc/` behavior changes.

## 8. Relation to CR-RBAC-001's execution order

CR-RBAC-004 was listed as one of the 4 CRs that can run in parallel with
CR-RBAC-002/005/006, all before CR-RBAC-001's Admin UI cutover. Since this
pass found CR-RBAC-004's backend-go work already done, it is **not a
blocker** for CR-RBAC-001 at all — the only residual item (the stale
frontend comment + missing UI control for team grants in
`GroupsAndGrantsTab`) is a `frontend/` cleanup, tracked here for whoever
executes CR-RBAC-001's frontend cutover to pick up alongside it.
