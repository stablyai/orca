# TASK-BE-032: Wire `admin.*Team*` wscompat channels

> **Status: ✅ DONE — 2026-09-11 — pivoted: admin-gated the existing `team.*` channels instead of
> creating new `admin.*Team*` ones**
>
> **Phát hiện quan trọng làm đổi cách làm:** `backend-go/services/api-gateway/internal/adapter/wscompat/
> channels_team.go` **đã tồn tại từ trước** với đúng cả 5 operation này (`team.create`, `team.list`,
> `team.addMember`, `team.removeMember`, `team.listMembers`) — implement gần như y hệt sketch của task
> này, và **đã được wire vào `RegisterRealChannels`** (`channels.go:170`, comment header của file đó tự
> nhận "not yet called" là **lỗi thời**, giống pattern BUG-013 đã thấy trước đây). Viết
> `channels_admin_teams.go` mới sẽ tạo ra 2 nhóm channel song song làm cùng 1 việc — đúng vấn đề
> CR-RBAC-001 đang cố xoá bỏ (2 hệ song song), không phải giải pháp. Đã xoá file `channels_admin_teams.go`
> vừa viết, thay vào đó:
> 1. Thêm admin-gate (`if id.Role != "admin" { return nil, errNotAdmin }`) vào cả 5 channel trong
>    `channels_team.go` (trước đó KHÔNG admin-gated — bất kỳ user nào cũng gọi được, 1 lỗ hổng thật).
> 2. Sửa lại comment đầu file (đã lỗi thời, giờ ghi đúng: đã được gọi từ `channels.go`, admin-gated).
> 3. `channels_team_test.go`: thêm `Role: "admin"` vào mọi `Identity` test hiện có + 1 test mới
>    `TestTeamChannels_RequireAdmin` (regression guard cho việc admin-gate vừa thêm).
> 4. **Không có `role` field nào được thêm** — đúng yêu cầu gốc của task này (`AddTeamMemberRequest`
>    vẫn chỉ có `Priority`).
>
> `go build`/`go test` sạch cho `api-gateway` (6/6 test `channels_team_test.go` pass, gồm test mới).
> `gofmt -l` sạch.
>
> **Việc còn lại (ngoài phạm vi task này, để cho phần frontend cutover)**: `frontend/`'s
> `web-preload-api.ts`'s `createTenantProfileApi()` vẫn chưa có bridge `listTeams`/`createTeam`/... sang
> `'team.*'` (FE-TASK-011 đã ghi nhận gap này) — giờ có thể gọi thẳng `team.*` (đã admin-gated), không
> cần đợi `admin.*Team*` nào nữa.

**Solution:** BE-SOL-008 §2.4 | **CR:** CR-RBAC-001
**Depends on:** none.

---

## Goal

Wire team CRUD (`CreateTeam`/`ListTeams`/`ListTeamMembers`/`AddTeamMember`/`RemoveTeamMember`, all
confirmed already implemented on `TenantServiceServer`) to `window.api.admin.*`, replacing the legacy
`callRuntimeRpc('team.*')` transport `TeamAdmin.tsx` currently uses (that legacy transport and its
backing `backend/src/main/team/TeamService.ts` are retired as part of CR-RBAC-001's frontend cutover —
this task is what the retiring frontend task switches to calling instead).

## What to do

Create `backend-go/services/api-gateway/internal/adapter/wscompat/channels_admin_teams.go`:

```go
type teamView struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type teamMemberView struct {
	TeamID   string `json:"teamId"`
	UserID   string `json:"userId"`
	Priority int32  `json:"priority"`
}

func registerAdminTeamChannels(r *Registry, client tenantv1.TenantServiceClient) {
	r.Register("admin.listTeams", /* {pageToken?, pageSize?} -> ListTeams -> {teams: teamView[], nextPageToken} */)
	r.Register("admin.createTeam", /* {name} -> CreateTeam -> teamView */)
	r.Register("admin.listTeamMembers", /* {teamId} -> ListTeamMembers -> {members: teamMemberView[]} */)
	r.Register("admin.addTeamMember", /* {teamId, userId, priority?} -> AddTeamMember -> {ok:true} */)
	r.Register("admin.removeTeamMember", /* {teamId, userId} -> RemoveTeamMember -> {ok:true} */)
}
```

Follow `channels_admin_users.go`'s exact per-channel shape (admin-gate first line, `decodeArg`/
`decodeOptionalArg`, `gatewaygrpc.AttachIdentity`, `context.WithTimeout(ctx, rpcTimeout)`).

**Do not add a `role` field to `teamMemberView` or `admin.addTeamMember`'s args.**
`tenant-service`'s `TeamMember{TeamID, UserID, Priority}` has no role concept — the legacy `TeamAdmin.tsx`'s
free-text `role` input was never persisted as anything meaningful server-side (confirmed in this CR
batch's audit). Reintroducing it here would recreate the exact UI-implies-a-feature-that-doesn't-exist
problem CR-RBAC-002 is separately fixing for the global role model. If a future CR adds real per-team
roles, that's a `tenant-service` domain change, out of scope here.

Add `registerAdminTeamChannels(r, tenantClient)` to `RegisterRealChannels` in `channels.go`.

## Acceptance Criteria

- [x] 5 channels registered (as `team.*`, reusing the pre-existing file): `.create`, `.list`,
      `.listMembers`, `.addMember`, `.removeMember`.
- [x] No `role` field anywhere in this file's types or wire args.
- [x] Each rejects non-admin `Identity` with `errNotAdmin` (test per channel + 1 combined regression test).
- [x] `go build ./...` and `go test ./...` clean for `api-gateway`.

## gitnexus

Run `impact({target:"registerAdminUserChannels", direction:"upstream"})` before editing `channels.go`
(same composition-root check every task in this file group runs).

## Blocking

None. Frontend's Teams-tab task (part of CR-RBAC-001's cutover) is blocked on this landing — it is the
replacement transport for the retiring `team.*` legacy RPC.
