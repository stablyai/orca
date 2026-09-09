# FE-TASK-011: Thêm type `TenantTeam` + khai báo preload `tenantProfile.listTeams`

**Domain:** team-rbac
**Solution Ref:** [FE-SOL-002](../solutions/FE-SOL-002-remove-dead-server-visibility-selector-and-wire-team-grant.md) Phần B
**CR:** [CR-RBAC-004](../../../../../../docs/crs/v4/team-rbac/CR-RBAC-004-project-team-scoped-server-visibility.md)
**Priority:** 🔴 P0
**Estimated:** 20 phút
**Status:** ✅ DONE — 2026-09-09 (xem "Kết quả thực tế" — premise "chưa có API liệt kê teams" ở đầu
file này đã LỖI THỜI tại thời điểm thực thi, verify lại thực tế bên dưới)

## Kết quả thực tế

**Verify lại premise ở đầu file bằng codegraph/grep trực tiếp trên backend-go (bắt buộc theo chỉ thị
của người điều phối trước khi làm task này):**

- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_team.go` đã có sẵn channel
  wscompat `team.list` gọi `tenantv1.TenantServiceClient.ListTeams` — trả về `resp.GetTeams()`.
- File đó tự ghi trong doc comment của nó: "Not yet called from RegisterRealChannels" — **comment
  này ĐÃ LỖI THỜI**. Xác nhận trực tiếp: `channels.go` dòng 170 có
  `registerTeamChannels(r, tenantClient)` — nằm trong danh sách gọi thật của
  `RegisterRealChannels` (composition root gọi từ `main.go`). Tức là **channel `team.list` ĐÃ sống
  ở tầng wscompat**, không còn là gap backend như task gốc giả định.
- Tuy nhiên, ở tầng frontend: `frontend/src/renderer/src/web/web-preload-api.ts`'s
  `createTenantProfileApi()` (bridge thật cho `window.api.tenantProfile.*` trên build web) **chưa
  có** entry `listTeams` gọi `callRuntimeResult('team.list')` — chỉ có `listDepartments` gọi
  `'profile.listDepts'`. Đây là **gap thật duy nhất còn lại**, khác hẳn gap task gốc mô tả (task gốc
  giả định thiếu RPC backend; thực tế RPC + wscompat channel đã có, chỉ thiếu 1 dòng bridge phía FE).
- Theo đúng phạm vi file đã khai trong task (chỉ 2 file: type + `preload/api-types.ts`) và ràng buộc
  "không tự mở rộng phạm vi" của người điều phối, **không sửa `web-preload-api.ts`** trong task này
  — chỉ ghi chú chính xác gap ở đây. Việc wire `listTeams` vào `web-preload-api.ts` là 1 follow-up
  1-dòng, không phải "chờ backend-go" nữa.

**Code đã thực thi (đúng 2 file đã khai):**

- `frontend/src/shared/tenant-user-profile-types.ts`: thêm `export type TenantTeam = { id: string;
  name: string }` (mirror `TenantDepartment`, kèm comment nêu rõ backing channel `team.list` và
  finding ở trên).
- `frontend/src/preload/api-types.ts`: thêm `TenantTeam` vào import từ `tenant-user-profile-types`,
  thêm `listTeams: () => Promise<TenantTeam[]>` vào namespace `tenantProfile`.

**Verify:**
- `cd frontend && npx tsc --noEmit -p tsconfig.json` — 0 lỗi type mới (147 dòng lỗi baseline trước
  đã tồn tại, không liên quan `tenant-user-profile-types.ts`/`api-types.ts`/`AdminDevServerConsole.tsx`
  — đã grep xác nhận các file này không xuất hiện trong output lỗi).
- `grep -n "TenantTeam\|listTeams" frontend/src/shared/tenant-user-profile-types.ts
  frontend/src/preload/api-types.ts` — khớp cả 2 vị trí đã thêm.

## ⚠️ Phụ thuộc backend-go (đọc trước khi thực thi)

`DevServerGranteeKind` (`frontend/src/shared/dev-server-types.ts:188`) đã là `'department' |
'team'` — type layer FE đã sẵn sàng. Nhưng **API liệt kê teams của tenant hiện tại chưa tồn tại**
(`window.api.tenantProfile.listTeams()` — không có channel wscompat nào khớp tên này hiện nay).
**Depends on:** backend-go's BE-TASK tương ứng của CR-RBAC-004 (xem
`specs/backend-go/crs/v4/team-rbac/tasks/`, đang được soạn song song, chưa tồn tại lúc task này
được viết — chỉ cần đối chiếu CR-RBAC-004/tên RPC `ListTeams`/`ListTeamsForUser` khi backend-go
sẵn sàng, không cần link file cụ thể). Task này chỉ thêm **type + khai báo preload phía FE**, không
chờ backend để bắt đầu — nhưng API sẽ không có tác dụng thật cho tới khi backend-go xong.

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/shared/tenant-types.ts` (hoặc file tương đương đang khai `TenantDepartment` — xác nhận tên file thật khi cài đặt) | MODIFY — thêm `TenantTeam` |
| `frontend/src/preload/api-types.ts` | MODIFY — thêm `tenantProfile.listTeams` |

## Các bước thực thi

**Bước 1 — xác nhận tên file thật khai `TenantDepartment`:**

```bash
grep -rln "TenantDepartment" frontend/src/shared frontend/src/preload
```

Thêm `TenantTeam` vào đúng file đó (mirror `TenantDepartment`):

```typescript
export type TenantTeam = {
  id: string
  name: string
}
```

**Bước 2 — `frontend/src/preload/api-types.ts`**, thêm vào namespace `tenantProfile`:

```typescript
/** Admin-only: lists teams in the caller's tenant (mirror listDepartments). */
listTeams: () => Promise<TenantTeam[]>
```

## Verify

```bash
cd frontend && npx tsc --noEmit -p tsconfig.json
grep -n "TenantTeam\|listTeams" frontend/src/shared/tenant-types.ts frontend/src/preload/api-types.ts
```

## Depends on

Không có (code FE độc lập). Backend-go's team-listing API cần xong để có tác dụng thật (xem cảnh
báo ở đầu).

## Blocking

FE-TASK-012 (dùng `TenantTeam` + `listTeams` để dựng UI). FE-TASK-020 (SOL-004's Teams tab) nên
dùng chung type `TenantTeam` này thay vì định nghĩa lại — đối chiếu khi thực thi.
