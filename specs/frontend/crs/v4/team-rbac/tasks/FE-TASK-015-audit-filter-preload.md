# FE-TASK-015: Preload `admin.queryAuditLog` nhận filter mới (actor/outcome)

**Domain:** team-rbac
**Solution Ref:** [FE-SOL-003](../solutions/FE-SOL-003-audit-log-filter-actor-and-outcome.md) Bước 2
**CR:** [CR-RBAC-005](../../../../../../docs/crs/v4/team-rbac/CR-RBAC-005-audit-log-outcome-and-coverage.md)
**Priority:** 🟡 P1
**Estimated:** 20 phút
**Status:** ✅ DONE — 2026-09-11

**Kết quả thực tế:** Đã xong thật sự cùng lúc với FE-TASK-017/014 — `web-preload-api.ts`'s
`queryAuditLog: (params) => callRuntimeResult(..., 'admin.queryAuditLog', params ?? {})` đã forward
nguyên `AdminAuditQuery` (gồm `actorId`/`action`/`outcome`) không lọc field nào ở tầng preload, đúng yêu
cầu. Không cần sửa gì thêm.

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/preload/api-types.ts` | MODIFY — namespace `admin`, chữ ký `queryAuditLog` |
| `frontend/src/renderer/src/web/web-preload-api.ts` | MODIFY — `createAdminApi()` truyền filter mới qua `callRuntimeResult('admin.queryAuditLog', params)` |

## Các bước thực thi

**`api-types.ts`** — sửa chữ ký `queryAuditLog` (namespace `admin`, đã khai khung cơ bản ở
FE-TASK-017) thành:

```typescript
queryAuditLog: (params: AdminAuditQuery) => Promise<{
  entries: AdminAuditEntry[]
  nextPageToken: string
}>
```

**`web-preload-api.ts`** — xác nhận `createAdminApi()`'s `queryAuditLog` truyền nguyên `params`
(bao gồm `actorId`/`outcome` mới) qua `callRuntimeResult('admin.queryAuditLog', params)` — không
lọc bớt field nào ở tầng preload.

## Verify

```bash
cd frontend && npx tsc --noEmit -p tsconfig.json
grep -n "queryAuditLog" frontend/src/preload/api-types.ts frontend/src/renderer/src/web/web-preload-api.ts
```

## Depends on

FE-TASK-014 (cần `AdminAuditQuery`/`AdminAuditEntry` đã mở rộng).

## Blocking

FE-TASK-016.
