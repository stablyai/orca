# BE-SOL-001: Admin surface RPC audit for backend-go (CR-RBAC-001's non-frontend half)

> **🔲 Proposed — not implemented.** This is primarily a verification
> document — see §2 for exactly what, if anything, needs a backend-go code
> change.

**CR:** [CR-RBAC-001](../../../../../../docs/crs/v4/team-rbac/CR-RBAC-001-consolidate-admin-surface-to-backend-go.md)
**Service:** auth-service, tenant-service (RPC surface only — the frontend
cutover itself, and the legacy `backend/` retirement, are `frontend`/legacy
scope, out of this backend-go solution set)
**Depends on:** [BE-SOL-005](./BE-SOL-005-audit-log-outcome-and-coverage.md)
(audit schema), [BE-SOL-006](./BE-SOL-006-opa-policy-publish-and-reload.md)
(policy publish) should land first — this CR is explicitly the **last**
solution to execute, per the CR set's own "Thứ tự thực thi."

---

## 1. What this CR needs from backend-go

CR-RBAC-001's actual code changes are almost entirely `frontend/` (retire
`AdminApp` et al.) and legacy-`backend/` deletions. Its backend-go
"Changes Required" table explicitly says: *"services/auth-service — Không
đổi code — chỉ cần CR-RBAC-005/006 xong trước"* and *"services/tenant-service
— Không đổi code cho CR này."* This solution's job is to **verify that claim
is actually true** — i.e. audit the RPC surface each planned Admin UI tab
needs and confirm it's complete — not to design new backend-go work.

## 2. RPC surface audit (verified via `codegraph_explore` this pass)

| Planned Admin UI tab | Needs | Verified status |
|---|---|---|
| Users | `ListUsers`, `UpdateUserRole`, `DeactivateUser`, `ReactivateUser`, `CreateUser` | ✅ All 5 present on `AuthServiceServer` (`auth_grpc.pb.go:339-379`'s interface listing — confirmed `CreateUser`, `ListUsers`, `UpdateUserRole`, `DeactivateUser`, `ReactivateUser` all declared and implemented in `adapter/grpc/server.go`). |
| Policies | `CreateAccessPolicy`, `GetAccessPolicy`, `ListAccessPolicies`, `UpdateAccessPolicy`, `DeleteAccessPolicy` | ✅ All 5 present (`auth_grpc.pb.go:359-363`). **But** effectively inert until BE-SOL-006 ships (`NoopPublisher`) — this tab is correctly sequenced after BE-SOL-006 in the CR set's execution order. |
| Teams | `CreateTeam`, `AddTeamMember`, `RemoveTeamMember`, `ListTeamMembers`, `ListTeams`, `ListTeamsForUser` | ✅ All 6 present on `TenantServiceServer` (`tenant_grpc.pb.go`'s interface, confirmed via `codegraph_explore`) — `ListTeamsForUser` additionally confirmed **already consumed** by 2 real call sites (see BE-SOL-004). No `UpdateTeam`/`DeleteTeam` found in the traced interface slice — **verify at implementation time** whether the Teams tab needs update/delete and, if so, whether those RPCs exist elsewhere in `tenant.proto` (not fully enumerated in this pass's budget). |
| Sessions | `ListSessionsForUser`, `ForceRevokeSession` (single), `ForceRevokeAllSessionsForUser` | ⚠️ `ListSessionsForUser` and `ForceRevokeAllSessionsForUser` confirmed present (`auth_grpc.pb.go:357-358`). **`ForceRevokeSession` (single-session revoke) was not found in the traced `AuthServiceServer` interface** — only `RevokeSession` (`auth_grpc.pb.go:353`, likely the caller's-own-session logout path, not an admin force-revoke of *another* user's session) and `ForceRevokeAllSessionsForUser` (kill-all) appear. **This is a real, small gap**: confirm whether `RevokeSession` already accepts an admin-supplied `session_token`/`session_id` for *any* user (not just self) — if not, the Sessions tab's "kill one session" action (distinct from "kill all") has no backing RPC yet and needs a small addition (`ForceRevokeSession(session_id) → Empty`, admin-gated, mirroring `ForceRevokeAllSessionsForUser`'s shape but for one row). |
| Audit | `QueryAuditLog` (+ outcome/actor/action filters) | ⚠️ RPC exists but needs BE-SOL-005's schema/filter extension first — correctly sequenced. |

## 3. The one confirmed gap: single-session force-revoke

If §2's finding holds after a full re-check of `auth.proto` (verify — this
pass's `codegraph_explore` calls were budgeted toward the higher-priority
CRs and only surfaced `AuthServiceServer`'s interface via 2 partial views;
a targeted `codegraph_explore("ForceRevokeSession admin session revoke auth.proto")`
should be the first step of implementing this CR), the fix is small and
mechanical, following `ForceRevokeAllSessionsForUser`'s exact existing shape:

```protobuf
// ForceRevokeSession is the admin-console single-session kill action —
// distinct from RevokeSession (caller revokes their OWN session, the
// logout path) and ForceRevokeAllSessionsForUser (kill every session for a
// user). Added for CR-RBAC-001's Sessions tab.
rpc ForceRevokeSession(ForceRevokeSessionRequest) returns (google.protobuf.Empty);

message ForceRevokeSessionRequest {
  string session_id = 1; // the opaque token's hash, as returned by ListSessionsForUser
}
```

Usecase `ForceRevokeSession`, admin-gated via `requireAdminActor` (identical
pattern to every other admin usecase in this service) — a 1:1 copy of
`ForceRevokeAllSessionsForUser`'s shape but calling
`SessionRepository.RevokeSession` (already exists, confirmed at
`postgres/session_repository.go:44-56`) for one `token_hash` instead of
`RevokeAllForUser`.

## 4. Files to change (only if §3's gap is confirmed real)

| File | Change |
|---|---|
| `backend-go/proto/orca/auth/v1/auth.proto` | `ForceRevokeSession` RPC + request message |
| `backend-go/services/auth-service/internal/usecase/force_revoke_session.go` (new) | Admin-gated single-session revoke, mirrors `force_revoke_all_sessions_for_user.go` |
| `backend-go/services/auth-service/internal/adapter/grpc/server.go` | Handler wiring |

If §3's premise is wrong (i.e. `RevokeSession` already supports an
admin-supplied target session for any user), this solution requires **zero**
backend-go code changes — confirming that is the actual first step, before
writing any code.

## 5. Out of scope

- Everything else in CR-RBAC-001: the `frontend/` cutover (`AdminOrgConsole.tsx`
  tabs), retiring `backend/src/main/admin/*`/`backend/src/main/team/*`, and
  the historical-data-migration decision — all explicitly out of scope for a
  backend-go-only solution set, and explicitly deferred/parked by the CR
  itself pending business sign-off (data migration) or a separate frontend
  session (the UI work).

## 6. Tests

- If §3's gap is confirmed: `force_revoke_session_test.go` — admin caller
  revokes another user's specific session; non-admin caller is denied
  (mirrors `requireAdminActor`'s existing test pattern across this service's
  15 other admin usecases).
- No test changes needed for the RPCs already confirmed present in §2.

## 7. Impact analysis (gitnexus)

| Symbol | Risk | Note |
|---|---|---|
| `AdminApp` (`frontend/.../admin/AdminApp.tsx`) | LOW (1 direct caller, `admin-main.tsx`) | From the CR set's own README summary table — re-confirm with `impact()` immediately before the frontend cutover deletes it; not re-run in this backend-go-only pass since it's a `frontend/` symbol. |
| `ForceRevokeAllSessionsForUser` (new sibling `ForceRevokeSession`'s nearest analog) | Not run this pass | Run `impact({target:"ForceRevokeAllSessionsForUser", direction:"upstream"})` before adding `ForceRevokeSession` alongside it, to confirm the existing RPC's blast radius and reuse its exact wiring pattern safely. |

## 8. Sequencing note (per the CR set's README)

```
BE-SOL-002 (role model + claim propagation) ─┐
BE-SOL-004 (server visibility — already done)│  independent, parallel
BE-SOL-005 (audit schema + coverage)         │
BE-SOL-006 (policy publish)                  ─┘
                    │
                    ▼
BE-SOL-001 (this doc — admin RPC surface audit) ← run LAST among the backend-go
                                                    solutions; the frontend
                                                    cutover itself runs after
                    │                               this, once §3's gap (if
                    ▼                               confirmed) is closed.
BE-SOL-003 (SSO group mapping + refresh) ─── depends on BE-SOL-002
                    │
BE-SOL-007 (SAML) ─────────────────────────── Backlog, depends on BE-SOL-003
```
