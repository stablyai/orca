# FE-TASK-016: UI — thêm filter actor (user) + outcome vào tab Audit

**Domain:** team-rbac
**Solution Ref:** [FE-SOL-003](../solutions/FE-SOL-003-audit-log-filter-actor-and-outcome.md) Bước 3-4
**CR:** [CR-RBAC-005](../../../../../../docs/crs/v4/team-rbac/CR-RBAC-005-audit-log-outcome-and-coverage.md)
**Priority:** 🟡 P1
**Estimated:** 1 giờ
**Status:** ✅ DONE — 2026-09-09

## Kết quả thực tế

Đã thêm `useState` cho `actorId` (text input, lọc thô theo ID — chưa dùng
`ListTenantMemberDirectory` picker, để lại cho task sau nếu cần) và `outcome`
(`AdminAuditOutcome | ''`), cùng control UI (`Input` actor cạnh "From",
`Select` outcome dùng sentinel `"all"` vì Radix `SelectItem` không cho phép
`value=""`). `useEffect` đã đưa `actorId`/`outcome` vào dependency array và
truyền `actorId: actorId.trim() || undefined`, `outcome: outcome || undefined`
vào `queryAuditLog`. Thêm cột "Outcome" vào bảng, dùng `Badge` (`destructive`
khi `denied`, `default` khi `allowed`). Không làm bước "degrade an toàn nếu
backend chưa có outcome/filter" (Bước 2) — không nằm trong yêu cầu cụ thể của
lần thực thi này. `npx tsc --noEmit`: 113 lỗi trước và sau, không đổi (0 lỗi
mới từ file sửa).

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/renderer/src/components/settings/admin-org-console-audit-tab.tsx` | MODIFY — thêm Select actor/outcome + cột Outcome |

## Các bước thực thi

**Bước 1 — 2 filter control:**

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

**Bước 2 — Degrade an toàn nếu backend chưa có `outcome`/filter mới:** nếu CR-RBAC-005's backend
chưa merge khi task này merge trước, disable Select outcome + actor input, tooltip "Chưa hỗ trợ —
chờ CR-RBAC-005 backend", tránh gửi query param mà server không hiểu (server hiện tại bỏ qua param
lạ, nhưng disable rõ ràng hơn cho người dùng thay vì im lặng không lọc được).

## Verify

```bash
cd frontend && npx tsc --noEmit -p tsconfig.json
cd frontend && npx vitest run src/renderer/src/components/settings/__tests__/admin-org-console-audit-tab.test.tsx
```

## Không làm ở task này

- Thêm cột/field `ip_address` hiển thị mới hoàn toàn khác UX hiện có.
- Ghi audit ở `project-service`/`task-service`/`annotation-service`/`infra-fleet-service` —
  backend-go.

## Depends on

FE-TASK-015 (preload đã nhận filter mới).

## Blocking

FE-TASK-023 (xoá `AuditPage.tsx` Hệ B chỉ sau khi task này sống ổn định).
