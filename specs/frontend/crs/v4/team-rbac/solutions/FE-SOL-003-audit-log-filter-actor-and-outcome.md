# FE-SOL-003: Audit UI — filter theo actor (user) + outcome

> 🔲 Proposed — chưa cài đặt.

## CR Reference

- **CR:** [CR-RBAC-005](../../../../../../docs/crs/v4/team-rbac/CR-RBAC-005-audit-log-outcome-and-coverage.md)
- **Mức độ:** 🟡 P1
- **Phụ thuộc cứng (backend-go):** `outcome`/`ip_address` phải tồn tại trên `AuditEntry` và
  `QueryAuditLog` phải nhận thêm filter `actor_id`/`outcome` — nếu chưa xong, solution này không có
  gì để gọi (UI có thể build trước nhưng disable filter, xem "Giải pháp" bước 4).
- **Phụ thuộc thứ tự với CR-RBAC-001:** CR-005's giải pháp gốc ghi rõ "Frontend audit UI (sau
  CR-RBAC-001, sống trong `AdminOrgConsole`)" — nghĩa là UI đích của solution này là 1 tab do
  [FE-SOL-004](./FE-SOL-004-consolidate-admin-spa-into-admin-org-console.md) (CR-RBAC-001) dựng lên
  (`admin-org-console-audit-tab.tsx`), không phải `AuditPage.tsx` (Hệ B, sẽ bị xoá bởi CR-001).
  README's "Thứ tự thực thi" lại xếp CR-005 chạy **trước** CR-001 — tức về mặt schema/RPC backend,
  CR-005 nên xong trước, nhưng UI đích của nó chỉ tồn tại sau khi CR-001 cutover. Solution này viết
  cho kịch bản CR-001 đã xong (tab Audit đã tồn tại trong `AdminOrgConsole`); nếu triển khai CR-005
  trước khi CR-001 cutover, áp dụng đúng logic dưới đây tạm thời vào `AuditPage.tsx`/
  `admin-api-client.ts`'s `AuditFilter` (Hệ B) rồi di trú lại khi cutover — không viết 2 lần logic
  filter.

## Impact analysis (gitnexus, đã chạy lại)

| Symbol | Direction | Risk | Impacted | Ghi chú |
|---|---|---|---|---|
| `AuditPage` (`components/admin/AuditPage.tsx`) | upstream | LOW | 0 | gitnexus không thấy caller — `AdminApp`'s `<Route element={<AuditPage/>}>` là JSX prop, không phải `CALLS` trực tiếp; đây là hạn chế biết trước của công cụ đối với React Router, KHÔNG kết luận `AuditPage` là dead code (nó có route thật trong `AdminApp.tsx`) |

Vì UI đích (`admin-org-console-audit-tab.tsx`) chưa tồn tại (do CR-001 chưa làm), không có symbol
thật để chạy `impact()` cho nó — sẽ chạy lại ngay trước khi implement, đúng quy tắc bắt buộc của
repo, một khi FE-SOL-004 đã tạo file này.

## Bối cảnh (đã xác nhận lại)

- `AuditEntry`/`AuditFilter` (Hệ B, `admin-api-client.ts:45-59`, đã đọc verbatim) không có
  `outcome`; `AuditPage.tsx` (đã đọc verbatim) chỉ filter `from`/`to`/`action` — đúng như audit gốc.
  `userId`/`userEmail` có sẵn trên `AuditEntry` nhưng route table chỉ **hiển thị** cột User, không
  có control filter nào theo user — xác nhận đúng gap.
- Backend-go's REST đã có sẵn `GET /v1/auth/audit-log` (`auth_admin_routes.go`'s
  `handleQueryAuditLog`, đã đọc verbatim) và `GET /admin/api/audit` (route thứ 2, cùng handler, xem
  `admin_routes.go:41`) — nhưng cả 2 hiện chỉ parse query `since`/`page_token`/`page_size`, **không
  có** `actor_id`/`action`/`resource_type`/`outcome` — khớp đúng CR-005's mô tả `QueryAuditLog`
  hiện tại.
- `AdminOrgConsole`'s `UsersTab`/`DepartmentsTab` không gọi REST trực tiếp — chúng gọi qua
  `window.api.admin.*`/`window.api.tenantProfile.*` (kênh wscompat riêng, xem
  `frontend/src/renderer/src/web/web-preload-api.ts`'s `createAdminApi()`). Audit tab mới (do
  CR-001 dựng) nhiều khả năng cũng theo pattern này — solution này giả định có
  `window.api.admin.queryAuditLog(params)`.

## Giải pháp

Solution này giả định `admin-org-console-audit-tab.tsx` đã tồn tại theo thiết kế cơ bản của
FE-SOL-004 (bảng + filter `from`/`to`, gọi `window.api.admin.queryAuditLog`) — chỉ bổ sung phần
filter mới.

### Bước 1 — Mở rộng type filter/entry

**File:** `frontend/src/shared/admin-audit-types.ts` (file mới hoặc mở rộng type đã có do
FE-SOL-004 tạo — xác nhận tên file thật khi cài đặt) (MODIFY)

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

### Bước 2 — Preload API nhận filter mới

**File:** `frontend/src/preload/api-types.ts` (MODIFY, namespace `admin`)

```typescript
queryAuditLog: (params: AdminAuditQuery) => Promise<{
  entries: AdminAuditEntry[]
  nextPageToken: string
}>
```

### Bước 3 — UI: thêm 2 filter control (actor picker + outcome select)

**File:** `frontend/src/renderer/src/components/settings/admin-org-console-audit-tab.tsx`
(MODIFY — file do FE-SOL-004 tạo)

```tsx
const [actorFilter, setActorFilter] = useState('')   // free-text email, hoặc Select nếu có
                                                        // ListTenantMemberDirectory picker sẵn có
const [outcomeFilter, setOutcomeFilter] = useState<AdminAuditOutcome | ''>('')

// Reuse pattern member-picker đã có ở nơi khác trong app (ví dụ nơi gán reviewer/assignee) nếu
// tồn tại sẵn component chọn user theo tenant member directory — kiểm tra lại khi cài đặt thay vì
// tự viết input free-text; ListTenantMemberDirectory RPC (auth-service, đã có sẵn) là nguồn dữ
// liệu đúng cho 1 Select thay vì gõ tay actorId.

<Select value={outcomeFilter} onValueChange={(v) => setOutcomeFilter(v as AdminAuditOutcome | '')}>
  <SelectTrigger className="h-8 w-[140px]"><SelectValue placeholder="All outcomes" /></SelectTrigger>
  <SelectContent>
    <SelectItem value="">All outcomes</SelectItem>
    <SelectItem value="allowed">Allowed</SelectItem>
    <SelectItem value="denied">Denied</SelectItem>
  </SelectContent>
</Select>
```

Thêm cột "Outcome" vào bảng kết quả (badge `variant="destructive"` khi `denied`, `variant="default"`
khi `allowed` — theo đúng convention badge trạng thái đã dùng ở `UsersTab`'s active/deactivated).

### Bước 4 — Degrade an toàn nếu backend chưa có `outcome`/filter mới

Nếu CR-005's backend chưa merge khi FE này merge trước (thứ tự thực thi lý tưởng là backend trước,
nhưng nếu ngược lại xảy ra): disable Select outcome + actor input, tooltip "Chưa hỗ trợ — chờ
CR-RBAC-005 backend", tránh gửi query param mà server không hiểu (server hiện tại bỏ qua param lạ,
nhưng disable rõ ràng hơn cho người dùng thay vì im lặng không lọc được).

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/shared/admin-audit-types.ts` (hoặc file tương đương do FE-SOL-004 tạo) | MODIFY — thêm `outcome`, `actorId`, `AdminAuditOutcome` |
| `frontend/src/preload/api-types.ts` | MODIFY — `admin.queryAuditLog` nhận filter mới |
| `frontend/src/renderer/src/web/web-preload-api.ts` | MODIFY — `createAdminApi()` truyền filter mới qua `callRuntimeResult('admin.queryAuditLog', params)` |
| `frontend/src/renderer/src/components/settings/admin-org-console-audit-tab.tsx` | MODIFY — thêm Select actor/outcome + cột Outcome |

## Verification (khi cài đặt)

```bash
cd frontend && npx tsc --noEmit -p tsconfig.json
cd frontend && npx vitest run src/renderer/src/components/settings/__tests__/admin-org-console-audit-tab.test.tsx
```

## Không làm ở solution này

- Thêm cột/field `ip_address` hiển thị mới hoàn toàn khác UX hiện có — chỉ thêm filter actor/outcome
  theo đúng acceptance criterion của F32 (đã nêu tên trong CR-005), không redesign bảng.
- Ghi audit ở `project-service`/`task-service`/`annotation-service`/`infra-fleet-service` — backend-go.
- Xây `admin-org-console-audit-tab.tsx` từ đầu (khung bảng + filter `from`/`to`, export CSV nếu giữ)
  — thuộc phạm vi FE-SOL-004 (CR-RBAC-001); solution này chỉ bổ sung 2 filter mới lên khung đã có.
