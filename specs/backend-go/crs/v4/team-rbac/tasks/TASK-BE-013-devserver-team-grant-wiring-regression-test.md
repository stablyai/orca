# TASK-BE-013: Regression test — confirm team-grant dev-server visibility wiring (already fixed under BUG-013)

> **Status: ✅ DONE — 2026-09-09**
> **Files modified:** `backend-go/services/api-gateway/internal/adapter/wscompat/channels_dev_server_access_control.go`,
> `backend-go/services/api-gateway/internal/adapter/wscompat/channels_onboarding.go`,
> `docs/features/F32-team-rbac.md`
>
> **Kết quả thực tế:** Deviation from the plan, found and not silently patched around: the exact
> wiring-level regression test this task asks for (assert `TeamIds` flows from `ListTeamsForUser`'s
> response into `ListDevServersForUser`'s request, AT the wscompat channel layer) **already exists** —
> `TestDevServerListForUserChannel_ResolvesDepartmentThenLists` in
> `channels_dev_server_access_control_test.go` (pre-existing in the repo before this task ran) already
> asserts on `infraClient.lastListDevServersForUserIn.GetTeamIds()` with an explicit comment calling out
> "the actual BUG-013 regression assertion." Adding a second, differently-named test asserting the exact
> same thing would be pure duplication, so no new test function was added — AC1 is satisfied by this
> pre-existing coverage instead. Did add: (1) the one-line fail-closed-is-deliberate comment at both
> `ListTeamsForUser` call sites (`devServer.listForUser` in `channels_dev_server_access_control.go` and
> `onboardingDetectAgentsAllServers` in `channels_onboarding.go`) — no behavior change; (2) a note in
> `docs/features/F32-team-rbac.md`'s "Project-scoped Server Visibility" section confirming the real scoping
> axis is Team/Department (`infra-fleet-service`), not Project, marking that section as historical/old
> architecture. Re-ran (unmodified) `TestListDevServersForUser_TeamGrantMatches` and its siblings —
> all pass. `go build`/`go test ./...` clean for `api-gateway` and `infra-fleet-service`.

**Solution:** BE-SOL-004 | **CR:** CR-RBAC-004
**Depends on:** none.

---

## Goal

BE-SOL-004 verified that CR-RBAC-004's central question ("does `infra-fleet-service` ever get real
`team_ids` for dev-server visibility") is **already fixed** under a prior fix labeled BUG-013 — both
wscompat call sites (`devServer.listForUser`, the onboarding fan-out) already resolve `TeamIds` via
`tenant-service.ListTeamsForUser` and forward them to
`infra-fleet-service.ListDevServersForUser`, whose usecase already implements the team-grant branch with
existing test coverage (`TestListDevServersForUser_TeamGrantMatches`).

**Do not re-implement anything here.** This task exists only to close the one real residual gap BE-SOL-004
found: nothing currently proves the *wscompat→infra-fleet-service wiring* itself won't silently regress if
`channels_dev_server_access_control.go` is refactored again — only the usecase-level branch has a test
today.

## What to do

1. In `backend-go/services/api-gateway/internal/adapter/wscompat/channels_dev_server_access_control_test.go`
   (create if missing), add a wiring-level regression test:

```go
// TestDevServerListForUserChannel_ForwardsTeamIdsFromListTeamsForUser asserts
// on the FAKE client's received request, not just the final response — the
// same shape as channels_workflow_test.go's
// TestWorkflowExecuteAdHocStepChannel_TenantIDComesFromIdentityNotArgs.
func TestDevServerListForUserChannel_ForwardsTeamIdsFromListTeamsForUser(t *testing.T) {
	// fake tenantClient.ListTeamsForUser returns ["team-a","team-b"]
	// assert the fake infraFleetClient.ListDevServersForUser call captured
	// TeamIds: ["team-a","team-b"]
}
```

2. Add a one-line code comment (no behavior change) at both `ListTeamsForUser` call sites in
   `channels_dev_server_access_control.go`/`channels_onboarding.go`, documenting that the fail-closed
   error handling (`return nil, err` on a `tenant-service` outage, rather than degrading to
   department-only visibility) is a **deliberate** choice, not an oversight — so a future reviewer doesn't
   "fix" it into a fail-open bug.

3. Re-run (do not modify) the existing usecase-level tests to reconfirm they still pass:
   `TestListDevServersForUser_TeamGrantMatches`, `TestListDevServersForUser_DirectDepartmentGrantMatches`,
   `TestListDevServersForUser_InheritsGrantFromParentGroup`.

4. Update `docs/features/F32-team-rbac.md`'s scoping-axis note (shared with TASK-BE-006 — do this once, not
   twice, if both tasks are picked up close together) to confirm the scoping axis is Team/Department
   (`infra-fleet-service`), not Project.

## Acceptance Criteria

- [x] New wiring-level test asserts `TeamIds` flows from `ListTeamsForUser`'s response into
      `ListDevServersForUser`'s request, at the wscompat channel layer (not just the usecase layer) —
      satisfied by pre-existing `TestDevServerListForUserChannel_ResolvesDepartmentThenLists`, see
      "Kết quả thực tế" above (no new duplicate test added).
- [x] One-line fail-closed-is-deliberate comment added at both call sites, no behavior change.
- [x] `TestListDevServersForUser_TeamGrantMatches` and its siblings still pass, unmodified.
- [x] `docs/features/F32-team-rbac.md` confirms Team/Department as the scoping axis.
- [x] `detect_changes()` shows only test-file [pre-existing, unmodified] and comment diffs — **no**
      `usecase/`/`adapter/grpc/` behavior changes. Confirmed via `detect_changes({scope:"compare",
      base_ref:"main"})`: only comment-only touches to `registerDevServerAccessControlChannels` and
      `onboardingDetectAgentsAllServers`, 0 affected execution flows.

## gitnexus

Re-run in this session (2026-09-09) via `impact({target:"ListDevServersForUser", direction:"upstream",
repo:"orca", file_path:"backend-go/services/infra-fleet-service/internal/usecase/list_dev_servers_for_user.go",
summaryOnly:true})` → **risk LOW**, impactedCount 3 (1 direct), 1 process (`run` in
`infra-fleet-service/cmd/server/main.go`) — matches BE-SOL-004's original numbers exactly, no drift:

| Symbol | Direction | Risk | Impacted | Note |
|---|---|---|---|---|
| `ListDevServersForUser` (usecase) | upstream | LOW | 3 (1 direct, 1 process) | Not modified by this task — read-only verification + test addition. |
| `ListTeamsForUser` (`tenant-service`) | upstream | LOW | 0 via `impact()`'s method-overload resolution — `codegraph_explore`'s call-graph is the authoritative evidence here; it found 2 real callers directly via source. |

## Blocking

None. This CR is **not** a blocker for CR-RBAC-001's frontend cutover — the only residual item is a
`frontend/` cleanup (stale comment in `AdminDevServerConsole.tsx` + missing team-grant UI control),
explicitly out of scope for this backend-go task set.
