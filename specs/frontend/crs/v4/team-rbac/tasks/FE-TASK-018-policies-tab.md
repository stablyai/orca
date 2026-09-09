# FE-TASK-018: Tab "Policies" trong `AdminOrgConsole`

**Domain:** team-rbac
**Solution Ref:** [FE-SOL-004](../solutions/FE-SOL-004-consolidate-admin-spa-into-admin-org-console.md) Bước 1
**CR:** [CR-RBAC-001](../../../../../../docs/crs/v4/team-rbac/CR-RBAC-001-consolidate-admin-surface-to-backend-go.md)
**Priority:** 🔴 P0
**Estimated:** 1.5 giờ
**Status:** ✅ DONE — 2026-09-11

**Kết quả thực tế:** Tạo `admin-org-console-policies-tab.tsx` — list + create form (name/kind/documentJson
textarea) + per-row edit/delete, gọi qua `window.api.admin.{listPolicies,createPolicy,updatePolicy,
deletePolicy}` (đã có sẵn từ FE-TASK-017). Đã wire vào `AdminOrgConsole.tsx` (`TabsTrigger`/`TabsContent`
"policies"). Có banner cảnh báo "chưa có tác dụng enforcement thật" (CR-RBAC-006 chưa xong) đúng yêu cầu
cảnh báo gốc của task. `npx tsc --noEmit`: 0 lỗi mới so với baseline.

## ⚠️ CẢNH BÁO — chờ CR-RBAC-006 trước khi merge tab này

Chỉ merge tab này **SAU KHI** backend-go's CR-RBAC-006 xong (`NoopPublisher` thay bằng
implementation thật cho policy publish). Nếu không, tab hiển thị "lưu thành công" nhưng policy
không có hiệu lực thật — đúng gap nguy hiểm mà CR-RBAC-006 mô tả (write ảo). Nếu CR-RBAC-001 buộc
phải chạy trước CR-RBAC-006 xong, **bắt buộc** thêm banner cảnh báo trong tab: "Thay đổi có thể
chưa có hiệu lực ngay — xem CR-RBAC-006".

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/renderer/src/components/settings/admin-org-console-policies-tab.tsx` | CREATE |
| `frontend/src/renderer/src/components/settings/AdminOrgConsole.tsx` | MODIFY — thêm `TabsTrigger`/`TabsContent` "Policies" |

## Các bước thực thi

**1. Tạo `admin-org-console-policies-tab.tsx`** — mirror cấu trúc
`admin-org-console-users-tab.tsx` (list + create form + per-row actions). `AccessPolicy` là JSON
document versioned (không phải form nhiều field như `AdminPolicy` cũ) — UI tối thiểu là 1 textarea
JSON:

```tsx
export function PoliciesTab(): React.JSX.Element {
  const [policies, setPolicies] = useState<AdminAccessPolicy[]>([])
  const [newDocumentJson, setNewDocumentJson] = useState('{}')

  useEffect(() => {
    window.api.admin.listPolicies().then(setPolicies).catch((err) => toast.error(String(err)))
  }, [])

  // create: window.api.admin.createPolicy({ name, kind, documentJson: newDocumentJson })
  // update: window.api.admin.updatePolicy({ id, documentJson, expectedVersion })
  // delete: window.api.admin.deletePolicy({ id })
  // render: bảng policies (name/kind/version) + nút edit mở textarea JSON + nút delete
  //   + banner cảnh báo CR-RBAC-006 nếu policy publish chưa xong (xem cảnh báo ở đầu file này)
}
```

**2. `AdminOrgConsole.tsx`** — thêm `<TabsTrigger value="policies">Policies</TabsTrigger>` +
`<TabsContent value="policies"><PoliciesTab /></TabsContent>`, mirror vị trí tab Users/Departments
hiện có.

## Verify

```bash
cd frontend && npx tsc --noEmit -p tsconfig.json
cd frontend && npx vitest run src/renderer/src/components/settings/__tests__/AdminOrgConsole.test.tsx
```

Chạy `gitnexus detect_changes({scope:"compare", base_ref:"main"})` trước khi commit — đây là thay
đổi additive (CREATE + thêm tab), nên tách riêng khỏi commit xoá Hệ B (FE-TASK-023) để dễ review.

## Depends on

FE-TASK-017 (namespace `admin.listPolicies`/`createPolicy`/`updatePolicy`/`deletePolicy` phải tồn
tại trước). Backend-go's CR-RBAC-006 (policy publish thật) — xem cảnh báo ở đầu, đây là điều kiện
**merge**, không phải điều kiện bắt đầu code.

## Blocking

FE-TASK-023 (xoá Hệ B — `PoliciesPage.tsx`/`PolicyForm.tsx` chỉ xoá sau khi tab này sống ổn định).
