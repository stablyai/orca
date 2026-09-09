# FE-TASK-020: Tab "Teams" trong `AdminOrgConsole` (chuyển từ Unix-socket RPC sang wscompat)

**Domain:** team-rbac
**Solution Ref:** [FE-SOL-004](../solutions/FE-SOL-004-consolidate-admin-spa-into-admin-org-console.md) Bước 3
**CR:** [CR-RBAC-001](../../../../../../docs/crs/v4/team-rbac/CR-RBAC-001-consolidate-admin-surface-to-backend-go.md)
**Priority:** 🔴 P0
**Estimated:** 1.5 giờ
**Status:** ✅ DONE — 2026-09-09

## Kết quả thực tế

Tạo `admin-org-console-teams-tab.tsx` — mirror cấu trúc list+create+per-row-actions của
`admin-org-console-users-tab.tsx`/`admin-org-console-policies-tab.tsx`, gọi qua `window.api.admin.*`
(đã implement sẵn từ FE-TASK-017, không phải sketch/TODO như bản nháp task này). Khác so với sketch:

- Không dùng field `id/name/createdAt/updatedAt` như sketch phỏng đoán — `AdminTeam` thật là
  `{id, company_id, name, settings_json}` (snake_case, proto passthrough — đã xác nhận qua
  `admin-team-types.ts`), row hiển thị `name` + `company_id`.
- `AdminTeamMember` xác nhận KHÔNG có field `role` (`{user_id, priority}` — đã confirm qua type file,
  không thêm role model developer/admin/lead vào đâu cả).
- Member panel hiện inline dưới mỗi team row qua state `expandedTeamId` (đúng gợi ý task), không dùng
  dialog riêng.
- Form tạo team có thêm textarea `settingsJson` nhỏ (optional) thay vì bỏ qua hoàn toàn.
- `AdminOrgConsole.tsx` KHÔNG bị sửa trong lần chạy này (đã được wire sẵn ở phiên khác theo yêu cầu).

`npx tsc --noEmit -p tsconfig.json`: baseline (trước khi sửa) = 114 lỗi không liên quan; sau khi thêm
file = 113 lỗi (không tăng), không có lỗi nào trong file mới tạo.

## Mục tiêu

Hệ B's `TeamAdmin.tsx` dùng `callRuntimeRpc('team.*', ...)` → Unix-socket RPC →
`backend/src/main/team/TeamService.ts` → SQLite `orca_teams`/`orca_team_members` (transport legacy,
tách biệt hoàn toàn). Chuyển sang `window.api.admin.listTeams/createTeam/addTeamMember/
removeTeamMember` (wscompat) → `tenant-service`'s `CreateTeam`/`AddTeamMember`/`RemoveTeamMember`/
`ListTeamMembers`/`ListTeams` (RPC đã có theo audit gốc).

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/renderer/src/components/settings/admin-org-console-teams-tab.tsx` | CREATE |
| `frontend/src/renderer/src/components/settings/AdminOrgConsole.tsx` | MODIFY — thêm `TabsTrigger`/`TabsContent` "Teams" |

## Các bước thực thi

**1. Tạo `admin-org-console-teams-tab.tsx`** — list teams + create + member management, gọi qua
`window.api.admin.*` (không phải `callRuntimeRpc`):

```tsx
export function TeamsTab(): React.JSX.Element {
  const [teams, setTeams] = useState<AdminTeam[]>([])
  const [newTeamName, setNewTeamName] = useState('')

  useEffect(() => {
    window.api.admin.listTeams().then(setTeams).catch((err) => toast.error(String(err)))
  }, [])

  // create: window.api.admin.createTeam({ name: newTeamName })
  // addTeamMember/removeTeamMember: window.api.admin.addTeamMember({ teamId, userId }) /
  //   removeTeamMember({ teamId, userId })
  // render: danh sách team + panel member list mỗi team (id/name/createdAt/updatedAt — Team type
  //   hiện tại KHÔNG có field role trên Team, chỉ có thể có trên TeamMember — xác nhận lại field
  //   thật khi cài đặt bằng cách đọc RPC response). Nếu TeamMember.role tồn tại, giá trị phải khớp
  //   role model đã chốt ở FE-TASK-001 (developer|admin, không có "lead").
}
```

**2. `AdminOrgConsole.tsx`** — thêm `<TabsTrigger value="teams">Teams</TabsTrigger>` +
`<TabsContent value="teams"><TeamsTab /></TabsContent>`.

## Lưu ý dùng chung dữ liệu với FE-SOL-002

Team tạo qua tab này chính là nguồn dữ liệu cho FE-TASK-012's Team grant picker
(`GroupsAndGrantsTab`). Dùng chung type `TenantTeam`/`AdminTeam` — đối chiếu lại 2 type này khi cài
đặt để tránh định nghĩa trùng lặp (1 type đủ, có thể alias).

## Verify

```bash
cd frontend && npx tsc --noEmit -p tsconfig.json
cd frontend && npx vitest run src/renderer/src/components/settings/__tests__/AdminOrgConsole.test.tsx
```

## Depends on

FE-TASK-017 (namespace `admin.listTeams`/`createTeam`/`addTeamMember`/`removeTeamMember`).

## Blocking

FE-TASK-023 (xoá Hệ B's `TeamAdmin.tsx` — chỉ sau khi tab này sống ổn định).
