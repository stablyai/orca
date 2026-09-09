# FE-TASK-014: Mở rộng type filter/entry Audit — `outcome`/`actorId`/`AdminAuditOutcome`

**Domain:** team-rbac
**Solution Ref:** [FE-SOL-003](../solutions/FE-SOL-003-audit-log-filter-actor-and-outcome.md) Bước 1
**CR:** [CR-RBAC-005](../../../../../../docs/crs/v4/team-rbac/CR-RBAC-005-audit-log-outcome-and-coverage.md)
**Priority:** 🟡 P1
**Estimated:** 20 phút
**Status:** ✅ DONE — 2026-09-11

**Kết quả thực tế:** Đã xong thật sự — khi viết FE-TASK-017, backend (TASK-BE-016/031) đã landed đủ
filter actor/action/outcome từ trước nên `admin-audit-types.ts`'s `AdminAuditEntry`/`AdminAuditQuery`/
`AdminAuditOutcome` được viết thẳng bản đầy đủ ngay từ đầu (không cần tách base→mở rộng 2 bước như task
này dự phòng ban đầu). Đối chiếu lại: type khớp đúng `auditEntryView`/`queryArgs` thật của
`channels_admin_audit.go`. Không cần sửa gì thêm ở file này.

## ⚠️ Phụ thuộc — đọc trước khi thực thi

1. **Cross-solution:** task này sửa lên tab Audit do **FE-TASK-019** (FE-SOL-004, CR-RBAC-001) tạo
   (`admin-org-console-audit-tab.tsx`). Nếu FE-TASK-019 chưa chạy, chưa có file đích để mở rộng —
   xác nhận file đã tồn tại trước khi bắt đầu.
2. **Backend-go (bắt buộc):** `outcome`/`ip_address` phải tồn tại trên `AuditEntry` và
   `QueryAuditLog` phải nhận thêm filter `actor_id`/`outcome` ở backend-go trước khi filter này có
   tác dụng thật. **Depends on:** backend-go's BE-TASK tương ứng của CR-RBAC-005 (xem
   `specs/backend-go/crs/v4/team-rbac/tasks/`, đang soạn song song). Nếu backend chưa xong, viết
   type/UI trước vẫn hợp lệ — chỉ cần disable filter khi gọi (xem FE-TASK-016 Bước 4).

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/shared/admin-audit-types.ts` (hoặc file type do FE-TASK-019 tạo — xác nhận tên file thật khi cài đặt) | MODIFY — thêm `outcome`, `actorId`, `AdminAuditOutcome` |

## Các bước thực thi

```typescript
export type AdminAuditOutcome = 'allowed' | 'denied'

export type AdminAuditEntry = {
  id: string
  createdAtUnixMs: number
  actorId: string
  actorEmail: string
  action: string
  resourceType?: string
  resourceId?: string
  outcome: AdminAuditOutcome
  ipAddress?: string
}

export type AdminAuditQuery = {
  pageToken?: string
  pageSize?: number
  since?: number
  actorId?: string
  action?: string
  resourceType?: string
  outcome?: AdminAuditOutcome
}
```

## Verify

```bash
cd frontend && npx tsc --noEmit -p tsconfig.json
grep -n "AdminAuditOutcome\|actorId\|outcome" frontend/src/shared/admin-audit-types.ts
```

## Depends on

FE-TASK-019 (file/type đích phải tồn tại). Backend-go's schema mở rộng `AuditEntry`/
`QueryAuditLog` (xem cảnh báo ở đầu — không chặn viết code FE, chỉ chặn tác dụng thật).

## Blocking

FE-TASK-015, FE-TASK-016.
