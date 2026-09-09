# FE-TASK-017: Mở rộng namespace `admin` ở preload cho Policies/Teams/Sessions/Audit

**Domain:** team-rbac
**Solution Ref:** [FE-SOL-004](../solutions/FE-SOL-004-consolidate-admin-spa-into-admin-org-console.md) Bối cảnh #3 + Files cần sửa
**CR:** [CR-RBAC-001](../../../../../../docs/crs/v4/team-rbac/CR-RBAC-001-consolidate-admin-surface-to-backend-go.md)
**Priority:** 🔴 P0
**Estimated:** 45 phút
**Status:** ✅ DONE — 2026-09-11

> **Kết quả thực tế:** Backend-go's 4 wscompat files landed trước (TASK-BE-029..032) với channel
> name thật khác giả định ban đầu ở vài chỗ — `admin.getPolicy` (thêm, không có trong sketch gốc),
> `admin.listSessions`/`admin.forceRevokeAllSessions`/`admin.forceRevokeSession` (không phải
> `admin.listSessionsForUser`/`admin.forceRevokeAllSessionsForUser`), và quan trọng nhất: **Teams
> không có `admin.*Team*` nào cả** — TASK-BE-032 pivot sang admin-gate 5 channel `team.*` có sẵn
> thay vì tạo channel mới trùng lặp. Type/preload viết đúng theo channel thật, không theo sketch:
> - `frontend/src/shared/admin-policy-types.ts`, `admin-session-types.ts`, `admin-audit-types.ts` —
>   camelCase, khớp `policyView`/`sessionView`/`auditEntryView` (view struct do backend viết).
> - `frontend/src/shared/admin-team-types.ts` — **snake_case** (`company_id`, `settings_json`,
>   `user_id`) vì `channels_team.go` trả thẳng `tenantv1.Team`/`TeamMember` proto struct
>   (`encoding/json` dùng tag proto gốc, không qua view-struct converter) — ghi rõ trong file để
>   người sau không tưởng nhầm là bug.
> - `web-preload-api.ts`'s `createAdminApi()` — 13 method mới, bridge đúng 13 channel thật.
> - Audit type đã viết thẳng bản đầy đủ (actorId/action/outcome) vì TASK-BE-016/031 đã xong trước —
>   không cần base-rồi-mở-rộng như task này dự phòng.
>
> **Gap phát hiện thêm khi verify bằng `tsc`:** FE-TASK-011's `tenantProfile.listTeams` (preload
> type đã khai từ Sprint 1.5) chưa từng có implementation trong `createTenantProfileApi()` —
> `AdminDevServerConsole.tsx`'s grant picker gọi nó với optional-chaining (`?.()`) làm no-op-an-toàn
> từ đó tới giờ. Đóng gap này trong cùng lượt: thêm
> `listTeams: () => callRuntimeResult<TenantTeam[]>('team.list')`. `npx tsc --noEmit` sạch sau khi
> thêm (lỗi duy nhất liên quan CR-RBAC-001 đã biến mất; các lỗi `tsc` còn lại trong repo không liên
> quan task set này).

## ⚠️ Phụ thuộc backend-go (đọc trước khi thực thi — nền tảng cho toàn bộ FE-TASK-018..021)

`AdminOrgConsole`'s `UsersTab`/`DepartmentsTab` gọi qua `window.api.admin.*`/
`window.api.tenantProfile.*` — 1 lớp preload-IPC/wscompat riêng
(`web-preload-api.ts`'s `createAdminApi()` → `callRuntimeResult('admin.createUser', ...)` →
backend-go's `channels_admin_users.go`). **Đây là transport ĐÚNG mọi tab mới phải theo** để nhất
quán với `UsersTab`/`DepartmentsTab` hiện có — KHÔNG gọi REST `/admin/api/*` trực tiếp dù REST đã
tồn tại đầy đủ ở backend-go (REST đó không phải lớp `AdminOrgConsole` dùng).

`grep` xác nhận **chỉ có** `channels_admin_users.go` tồn tại — không có
`channels_admin_policies.go`/`channels_admin_sessions.go`/`channels_admin_audit.go`/tương đương
Teams. Nghĩa là dù gRPC RPC (`ListAccessPolicies`, `ListSessionsForUser`, `QueryAuditLog`...) và cả
REST `/admin/api/*` đã có, **cầu nối wscompat mà web app thật sự dùng thì chưa tồn tại**.

**Depends on:** backend-go's BE-TASK tương ứng của CR-RBAC-001 (thêm các channel wscompat
`admin.listPolicies`/`admin.createPolicy`/`admin.updatePolicy`/`admin.deletePolicy`/
`admin.listSessionsForUser`/`admin.revokeSession`/`admin.forceRevokeAllSessionsForUser`/
`admin.queryAuditLog`/`admin.listTeams`/`admin.createTeam`/`admin.addTeamMember`/
`admin.removeTeamMember`, mirror `channels_admin_users.go` — mỗi channel wrap đúng 1 gRPC call) —
xem `specs/backend-go/crs/v4/team-rbac/tasks/`, đang soạn song song, chưa tồn tại lúc task này được
viết. Task FE này viết theo giả định tên channel trên tồn tại — **xác nhận lại tên channel thật khi
cài đặt** (grep `channels_admin_*.go` ở backend-go trước khi code).

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/preload/api-types.ts` | MODIFY — mở rộng namespace `admin` |
| `frontend/src/renderer/src/web/web-preload-api.ts` | MODIFY — `createAdminApi()` thêm method |

## Các bước thực thi

**1. `frontend/src/preload/api-types.ts`** — thêm vào namespace `admin` (mirror shape các method
đã có cho Users, ví dụ `createUser`/`updateUserRole`):

```typescript
// Policies
listPolicies: () => Promise<AdminAccessPolicy[]>
createPolicy: (params: { name: string; kind: string; documentJson: string }) => Promise<AdminAccessPolicy>
updatePolicy: (params: { id: string; documentJson: string; expectedVersion: number }) => Promise<AdminAccessPolicy>
deletePolicy: (params: { id: string }) => Promise<void>

// Teams
listTeams: () => Promise<AdminTeam[]>
createTeam: (params: { name: string }) => Promise<AdminTeam>
addTeamMember: (params: { teamId: string; userId: string }) => Promise<void>
removeTeamMember: (params: { teamId: string; userId: string }) => Promise<void>

// Sessions
listSessionsForUser: (params: { userId: string }) => Promise<AdminSession[]>
revokeSession: (params: { sessionId: string }) => Promise<void>
forceRevokeAllSessionsForUser: (params: { userId: string }) => Promise<void>

// Audit (khung cơ bản — filter actor/outcome mở rộng ở FE-TASK-014/015, sau khi FE-TASK-019 tạo tab)
queryAuditLog: (params: { since?: number }) => Promise<{ entries: AdminAuditEntry[]; nextPageToken: string }>
```

Định nghĩa các type `AdminAccessPolicy`/`AdminTeam`/`AdminSession`/`AdminAuditEntry` tối thiểu theo
đúng field RPC gRPC tương ứng trả về (`ListAccessPolicies`, `ListTeams`, `ListSessionsForUser`,
`QueryAuditLog`) — xác nhận field thật khi cài đặt bằng cách đọc proto/RPC signature ở backend-go
(ngoài phạm vi sửa code FE, chỉ đọc để khớp type).

**2. `frontend/src/renderer/src/web/web-preload-api.ts`** — trong `createAdminApi()`, thêm các
method trên, mỗi method gọi `callRuntimeResult('admin.<tên channel>', params)` (mirror pattern
`createUser`/`updateUserRole` đã có).

## Verify

```bash
cd frontend && npx tsc --noEmit -p tsconfig.json
grep -n "listPolicies\|listTeams\|listSessionsForUser\|queryAuditLog" frontend/src/preload/api-types.ts frontend/src/renderer/src/web/web-preload-api.ts
```

## Depends on

Backend-go's wscompat channels (xem cảnh báo ở đầu). Không phụ thuộc FE task nào khác.

## Blocking

FE-TASK-018, FE-TASK-019, FE-TASK-020, FE-TASK-021 (cả 4 tab mới đều gọi qua namespace `admin` mở
rộng ở task này).
