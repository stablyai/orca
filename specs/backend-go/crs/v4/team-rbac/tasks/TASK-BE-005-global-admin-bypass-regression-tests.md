# TASK-BE-005: Regression tests — global admin bypasses membership, both auth paths

> **Status: ✅ DONE — 2026-09-09**

**Solution:** BE-SOL-002 | **CR:** CR-RBAC-002
**Depends on:** TASK-BE-003 (`callerGlobalRole` fix) and TASK-BE-004 (bearer-path `Role` claim) — both
must land first, otherwise these tests would fail (that's the point: they reproduce the bug this CR
fixes).

---

## Goal

No test today exercises "global admin, no project membership, calling via project-service" for either
auth path — `codegraph_explore`'s blast-radius scan in BE-SOL-002 found "no covering tests found" on both
`requireProjectAccess` and `requireRepoAccess`. Add that coverage.

## What to do

New table-driven test in `backend-go/services/project-service/internal/usecase/authorization_test.go`
(create the file if it doesn't exist — verify first):

```go
func TestRequireProjectAccess_GlobalAdminBypassesMembership(t *testing.T) {
	ctx := tenant.WithUserID(context.Background(), "admin-user")
	ctx = tenant.WithRole(ctx, "admin")
	membership := &fakeMembershipRepo{err: domain.ErrMembershipNotFound}
	opa := &fakeOPAClient{} // real project.rego semantics via a small in-memory stub, or the real Evaluator against the bundle
	err := requireProjectAccess(ctx, membership, opa, "proj-1", projectActionOwnerOnly)
	require.NoError(t, err)
}

func TestRequireProjectAccess_NoRoleClaimStaysDeny(t *testing.T) {
	// tenant.WithRole never called — Role(ctx) returns ok=false — must NOT
	// be silently treated as admin.
}
```

Mirror both cases for `requireRepoAccess`.

**Important**: if the fake `OPAClient` doesn't already evaluate real Rego, prefer wiring these against the
real `opaclient.Client` + `policy.Evaluator` pointed at the checked-in bundle
(`backend-go/policy/orca-authz`) — this is the one place a fake risks masking exactly the bug this CR
fixes (a fake that always returns `true` would pass even with the old hard-coded `""`).

## Acceptance Criteria

- [x] 4 test cases total: `{requireProjectAccess, requireRepoAccess} × {admin bypass, no-claim deny}`.
- [x] At least the "admin bypass" cases exercise real `project.rego`/`repo.rego` evaluation (not a fake
      that always returns `true`) — confirms the fix actually changes OPA's decision, not just that Go
      code compiles.
- [x] `TestRequireProjectAccess_NoRoleClaimStaysDeny` and its `requireRepoAccess` mirror prove an absent
      role claim is never silently treated as admin (fail-closed contract).
- [x] `go test ./services/project-service/... -run TestRequireProjectAccess -run TestRequireRepoAccess -v`
      passes.

## gitnexus

Actual `impact()` numbers recorded this pass (callgraph, upstream, repo "orca"):
- `requireProjectAccess`: **HIGH risk, 19 impacted** (19 direct callers — every OPA-gated project-service
  usecase's `Execute` method: `AddMember`, `AddRepo`, `AssignRepoToProject`, `DeleteProject`, `GetProject`,
  `GetSharedProjectData`, `LinkSourceProject`, `ListMembers`, `ListRepos`, `ListSourceProjects`,
  `ListWorktrees`, `MoveProject`, `RebindDevServer`, `RebindRepoDevServer`, `RemoveMember`, `ReorderRepos`,
  `UnlinkSourceProject`, `UpdateMemberRole`, `UpdateProject`).
- `requireRepoAccess`: **MEDIUM risk, 9 impacted** (9 direct callers: `AddRepoMember`, `ListRepoMembers`,
  `ListSparsePresets`, `RemoveRepo`, `RemoveRepoMember`, `RemoveSparsePreset`, `SaveSparsePreset`,
  `UpdateRepo`, `UpdateRepoMemberRole`).

Both numbers differ from BE-SOL-002's earlier "MEDIUM risk, 30 impacted" estimate (that number likely
combined both functions, or was taken before more usecases were added) — recorded here as the actual
current-tree figures. This task is test-only (no production symbol modified), so the real risk of THIS
change is zero regardless of the target functions' own blast radius; the `impact()` run's purpose was to
confirm understanding of `requireProjectAccess`/`requireRepoAccess`'s current callers before writing tests
against them, per the mandatory pre-edit-review process.

`detect_changes({scope:"compare", base_ref:"main"})` run after adding these tests — see
`specs/backend-go/crs/v4/team-rbac/tasks/README.md`'s "Wave 2 — kết quả thực thi" section for the full,
shared result across all 5 Wave 2 tasks (single run at the end, not per-task, since gitnexus diffs the
whole working tree).

## Kết quả thực tế

New file `backend-go/services/project-service/internal/usecase/authorization_test.go` with exactly the 4
prescribed test cases, wired against the REAL `opaclient.Client` + `common/policy.Evaluator` pointed at the
checked-in bundle (`backend-go/policy/orca-authz`, via `realBundlePath = "../../../../policy/orca-authz"`)
— not the package's existing `projectRegoDecide`/`repoRegoDecide` Go-reimplementation fakes, and not an
always-true stub, per this task's explicit caution. `fakeProjectRepository`/`fakeRepoRepository` (already
in `fakes_test.go`) stand in for the membership repositories, seeded with
`ErrMembershipNotFound`/`ErrRepoMembershipNotFound` so the "no membership row" path is exercised alongside
the real OPA decision.

- `go build ./...` (project-service module): clean.
- `go test ./services/project-service/... -run TestRequireProjectAccess -run TestRequireRepoAccess -v`:
  all 4 tests **PASS**.
- `go test ./...` (project-service module, full suite): **PASS** (no regressions).
- `gofmt -l internal/usecase/authorization_test.go`: no output (clean).

## Blocking

Blocked on TASK-BE-003 and TASK-BE-004 — both already DONE in the working tree (`callerGlobalRole` reads
`tenant.Role(ctx)`; bearer-JWT path propagates the `Role` claim), confirmed via `codegraph_explore` before
writing these tests.
