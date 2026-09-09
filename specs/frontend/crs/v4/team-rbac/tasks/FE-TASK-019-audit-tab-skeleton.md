# FE-TASK-019: Tab "Audit Log" (khung cơ bản, chưa filter actor/outcome) trong `AdminOrgConsole`

**Domain:** team-rbac
**Solution Ref:** [FE-SOL-004](../solutions/FE-SOL-004-consolidate-admin-spa-into-admin-org-console.md) Bước 2
**CR:** [CR-RBAC-001](../../../../../../docs/crs/v4/team-rbac/CR-RBAC-001-consolidate-admin-surface-to-backend-go.md)
**Priority:** 🔴 P0
**Estimated:** 1 giờ
**Status:** ✅ DONE — 2026-09-11

**Kết quả thực tế:** Tạo `admin-org-console-audit-tab.tsx` — filter "From" (date) + bảng Time/Actor/
Action/Resource, gọi `window.api.admin.queryAuditLog({sinceUnixMs})`. Đã wire vào `AdminOrgConsole.tsx`
(`TabsTrigger`/`TabsContent` "audit"). Filter actor/outcome (FE-TASK-016) làm ở lượt kế tiếp trên cùng
file này (khung cơ bản đã có nơi để thêm). `npx tsc --noEmit`: 0 lỗi mới so với baseline.

## Mục tiêu

Dựng khung tab Audit cơ bản: bảng + filter `from`/`to` (ngang hàng `AuditPage.tsx` cũ), gọi
`window.api.admin.queryAuditLog({ since })`. Filter `actor`/`outcome` **không thuộc phạm vi task
này** — đó là FE-TASK-014/015/016 (FE-SOL-003, CR-RBAC-005), chạy sau khi tab này tồn tại.

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/renderer/src/components/settings/admin-org-console-audit-tab.tsx` | CREATE |
| `frontend/src/renderer/src/components/settings/AdminOrgConsole.tsx` | MODIFY — thêm `TabsTrigger`/`TabsContent` "Audit" |

## Các bước thực thi

**1. Tạo `admin-org-console-audit-tab.tsx`** — khung bảng + filter `from`/`to`:

```tsx
export function AuditTab(): React.JSX.Element {
  const [entries, setEntries] = useState<AdminAuditEntry[]>([])
  const [since, setSince] = useState<number | undefined>(undefined)

  useEffect(() => {
    window.api.admin.queryAuditLog({ since }).then((r) => setEntries(r.entries)).catch((err) => toast.error(String(err)))
  }, [since])

  // render: 2 date input (from/to → tính since) + bảng cột (Time, Actor, Action, Resource)
  //   — cột Outcome + filter actor/outcome do FE-TASK-014/015/016 bổ sung sau
}
```

**2. `AdminOrgConsole.tsx`** — thêm `<TabsTrigger value="audit">Audit Log</TabsTrigger>` +
`<TabsContent value="audit"><AuditTab /></TabsContent>`.

## Verify

```bash
cd frontend && npx tsc --noEmit -p tsconfig.json
cd frontend && npx vitest run src/renderer/src/components/settings/__tests__/AdminOrgConsole.test.tsx
```

## Depends on

FE-TASK-017 (namespace `admin.queryAuditLog` phải tồn tại trước).

## Blocking

FE-TASK-014, FE-TASK-015, FE-TASK-016 (FE-SOL-003 — thêm filter actor/outcome lên khung tab này).
FE-TASK-023 (xoá Hệ B's `AuditPage.tsx` — chỉ sau khi tab này + FE-TASK-014..016 sống ổn định).
