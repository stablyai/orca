# TASK-BE-003: `callerGlobalRole` reads `tenant.Role(ctx)` instead of hard-coding `""`

> **Status: ✅ DONE — 2026-09-09**
> **Files modified:** `backend-go/services/project-service/internal/usecase/authorization.go`,
> `backend-go/common/tenant/tenant.go` (doc comment)
>
> **Kết quả thực tế:** `callerGlobalRole` now reads `tenant.Role(ctx)` exactly per the sketch above — no
> signature change, `requireProjectAccess`/`requireRepoAccess` untouched mechanically. `common/tenant.Role`'s
> doc comment was updated in the SAME pass as TASK-BE-004 (landed together in this session), so it states
> the final, accurate contract (both cookie/session and bearer-JWT paths populate it) rather than a TODO
> placeholder — see that task's own file for its half of the change. `go build ./...` clean for every
> backend-go module (not just project-service); `go test ./...` clean for `project-service` (no existing
> test asserted on the old hard-coded `""`, so no test needed updating). `gofmt -l` clean.

**Solution:** BE-SOL-002 | **CR:** CR-RBAC-002
**Depends on:** none — independent of every other task in this set.

---

## Goal

Close the actual dead-code bug CR-RBAC-002 is named after: `project-service`'s `callerGlobalRole` hard-codes
`return ""`, which makes `project.rego`/`repo.rego`'s "global admin override" branch structurally
unreachable from Go, even though the surrounding claim-propagation plumbing
(api-gateway → grpcmw → `tenant.WithRole`) already exists and is tested for the cookie/session auth path.

## What to do

Edit `backend-go/services/project-service/internal/usecase/authorization.go`:

```go
// callerGlobalRole resolves the acting user's system-wide role for
// project.rego's admin-override branch, from the role claim api-gateway
// attaches via grpcmw.MetadataRole (common/tenant.WithRole) — see
// common/tenant.Role's doc comment for the fail-closed contract: an absent
// claim (ok==false) is treated as "", never as an implicit allow.
func callerGlobalRole(ctx context.Context) string {
	role, _ := tenant.Role(ctx)
	return role
}
```

No signature change — both of `callerGlobalRole`'s direct callers (`requireProjectAccess`,
`requireRepoAccess`) are unaffected mechanically; only the *value* passed to `opa.Decision`/
`opa.RepoDecision` changes for the caller-is-global-admin case. Behavior change is strictly additive: a
previously-denied global-admin-without-membership call now succeeds; no previously-allowed call becomes
denied.

Update `common/tenant.Role`'s doc comment too (`backend-go/common/tenant/tenant.go`) — it currently says
"only the cookie/session path populates this," which will become inaccurate once TASK-BE-004 lands the
bearer-JWT path. If TASK-BE-004 hasn't landed yet when this task is done, leave a one-line TODO note in
the comment rather than an inaccurate claim either way — check `git log`/the doc's current wording before
editing.

## Acceptance Criteria

- [x] `callerGlobalRole` reads `tenant.Role(ctx)`, no longer hard-codes `""`.
- [x] Doc comment on `callerGlobalRole` explains where the role claim comes from (api-gateway →
      `grpcmw.MetadataRole` → `tenant.WithRole`).
- [x] `go build ./...` clean for `project-service`.
- [x] No signature change to `callerGlobalRole`, `requireProjectAccess`, or `requireRepoAccess`.

## gitnexus

Re-run in this session (2026-09-09) via `impact({target:"callerGlobalRole", direction:"upstream",
repo:"orca", summaryOnly:true})` — numbers below are the LIVE re-run result and match BE-SOL-002's original
pass exactly (no drift since):

| Symbol | Direction | Risk | Impacted | Note |
|---|---|---|---|---|
| `callerGlobalRole` | upstream | **MEDIUM** | 30 (2 direct, module `Usecase`) | The 30 are every usecase transitively reachable through `requireProjectAccess`/`requireRepoAccess` — none of their signatures change, only the returned role value for admin actors. |
| `WithRole` (`common/tenant/tenant.go:47`) | upstream | **CRITICAL** | 18 (1 direct, 9 processes) | **Not modified by this task** — flagged per the repo's CRITICAL-risk warning rule only because `WithRole` is a shared primitive with high fan-out. This task adds no new call to `WithRole` and does not touch its signature/behavior. |

**Warning**: before committing, run `detect_changes({scope:"compare", base_ref:"main"})` and confirm the
diff only touches `project-service/internal/usecase/authorization.go` (plus `tenant.go`'s doc comment, no
behavior change) — if the diff shows `WithRole`/`Role`'s function bodies changed, stop and re-review.

## Blocking

None. TASK-BE-005 (regression tests) depends on this task **and** TASK-BE-004 both landing.
