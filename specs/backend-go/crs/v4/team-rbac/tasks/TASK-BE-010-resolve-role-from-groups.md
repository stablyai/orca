# TASK-BE-010: `resolveRoleFromGroups` + wire into `LoginOrProvisionSsoUser`

> **Status: ✅ DONE — 2026-09-11**
>
> **Kết quả thực tế:** Đúng như kế hoạch — `resolveRoleFromGroups` implement trong
> `login_or_provision_sso_user.go`, wire vào cả nhánh new-user (provision) và returning-user (chỉ nâng
> quyền, không hạ — đúng quyết định anti-lockout, có comment tại chỗ). 4 test mới:
> `TestLoginOrProvisionSsoUser_NewUser_GroupMapsToAdmin_ProvisionedAsAdmin`,
> `TestLoginOrProvisionSsoUser_ReturningUserRole_GroupsNowMapToAdmin_Upgraded`,
> `TestLoginOrProvisionSsoUser_ReturningAdminRole_GroupsNoLongerMapToAdmin_RoleUnchanged`,
> `TestLoginOrProvisionSsoUser_MappingLookupError_FailsClosedToRoleUser` — cùng toàn bộ 11 test của file
> (cũ+mới) pass. `go build`/`go test` sạch cho `auth-service`. (Ghi chú: task này được 1 phiên trước đó
> hoàn thành code nhưng bị gián đoạn giữa chừng do rate limit trước khi cập nhật status — verify + đánh
> dấu lại ở đây.)

**Solution:** BE-SOL-003 | **CR:** CR-RBAC-003
**Depends on:** TASK-BE-007 (OIDC `Groups`), TASK-BE-009 (mapping table + repository port). TASK-BE-008
(GitHub `Groups`) is not a hard blocker — this task can be implemented and tested against OIDC groups
alone, then automatically picks up GitHub groups once TASK-BE-008 lands (same `Groups []string` field).

---

## Goal

Map `VerifiedSsoIdentity.Groups` against `sso_group_role_mapping` to resolve a role, and apply it with a
deliberate **anti-lockout** rule: only ever *upgrade* role from group membership, never auto-downgrade.

**Verify `login_or_provision_sso_user.go`'s exact current structure before implementing** — it was not
re-read in full during BE-SOL-003's pass.

## What to do

1. New function (in `login_or_provision_sso_user.go` or a sibling file in the same package):

```go
// resolveRoleFromGroups maps identity.Groups against
// sso_group_role_mapping, returning the highest-privilege matching role
// (admin > user), or domain.RoleUser if no group matches. Called ONLY when
// provisioning a brand-new user — see this function's own doc comment for
// why an existing user's role is never touched here.
func resolveRoleFromGroups(ctx context.Context, mapping SsoGroupRoleMappingRepository, tenantID string, identity VerifiedSsoIdentity) (domain.Role, error) {
	rows, err := mapping.ListForProvider(ctx, tenantID, identity.Provider)
	if err != nil {
		return domain.RoleUser, err // fail closed to the least-privileged role, never fail closed to admin
	}
	role := domain.RoleUser
	for _, g := range identity.Groups {
		if r, ok := matchGroup(rows, g); ok && r == domain.RoleAdmin {
			role = domain.RoleAdmin
			break
		}
	}
	return role, nil
}
```

2. Wire into `LoginOrProvisionSsoUser`:
   - **First provisioning** (new-user path): call `resolveRoleFromGroups`, set the new user's role from
     the result.
   - **Returning user** (every login, not just first-provision): compute the group-implied role; if it's
     `admin` and the stored user's role is currently `user`, call `UpdateUserRole` to upgrade; if the
     group-implied role is `user` but the stored role is `admin`, **do nothing** (deliberate anti-lockout
     decision — an admin who removed themselves from `orca-admins` in the IdP keeps their manually-granted
     admin role until an actual admin revokes it via `UpdateUserRole`). Comment this decision at the call
     site verbatim — it's deliberate, not an oversight.

## Acceptance Criteria

- [x] New user, group maps to `admin` → provisioned as `admin`.
- [x] Returning `user`-role account whose current IdP groups now map to `admin` → upgraded.
- [x] Returning `admin`-role account (manually granted) whose IdP groups no longer include an admin-mapped
      group → role unchanged (regression guard for the anti-lockout decision — this is the single most
      important test case in this task).
- [x] A `ListForProvider` repository error fails closed to `domain.RoleUser`, never to `domain.RoleAdmin`.
- [x] `login_or_provision_sso_user_test.go` extended with the 4 cases above.
- [x] `go build ./...` / `go test ./...` clean for `auth-service`.

## gitnexus

Not run with numeric results in BE-SOL-003's pass. Run
`impact({target:"LoginOrProvisionSsoUser", direction:"upstream"})` before editing — expected LOW risk
(auth-service-internal). `codegraph_explore`'s "callers" list for `VerifiedSsoIdentity` already showed only
`auth-service` files consume it.

## Blocking

Blocked on TASK-BE-007 and TASK-BE-009.
