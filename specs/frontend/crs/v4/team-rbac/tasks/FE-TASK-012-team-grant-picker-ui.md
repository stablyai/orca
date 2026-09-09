# FE-TASK-012: Wire Team grant picker vào `GroupsAndGrantsTab` (mirror Department)

**Domain:** team-rbac
**Solution Ref:** [FE-SOL-002](../solutions/FE-SOL-002-remove-dead-server-visibility-selector-and-wire-team-grant.md) Phần B
**CR:** [CR-RBAC-004](../../../../../../docs/crs/v4/team-rbac/CR-RBAC-004-project-team-scoped-server-visibility.md)
**Priority:** 🔴 P0
**Estimated:** 1 giờ
**Status:** ✅ DONE — 2026-09-09 (UI wired đầy đủ theo mirror Department; xem "Kết quả thực tế" cho
gap thật còn lại — không phải "chờ backend-go" như cảnh báo gốc)

## Kết quả thực tế

- Gap thật (xem chi tiết ở FE-TASK-011's "Kết quả thực tế"): backend-go's `team.list` wscompat
  channel đã sống (wired vào `RegisterRealChannels`), nhưng `web-preload-api.ts` chưa bridge
  `tenantProfile.listTeams` tới nó → `window.api.tenantProfile.listTeams` hiện **có type nhưng
  runtime trả `undefined`** trên build web cho tới khi 1 follow-up nhỏ (ngoài phạm vi 4 task này)
  thêm `listTeams: () => callRuntimeResult<TenantTeam[]>('team.list')` vào
  `createTenantProfileApi()`. Code UI trong task này dùng `listTeams?.()` (optional chaining, đúng
  theo mẫu task gốc) nên không crash khi thiếu — Select "Grant a team access" hiển thị nhưng rỗng
  cho tới khi bridge đó được thêm.
- Đã sửa `frontend/src/renderer/src/components/settings/AdminDevServerConsole.tsx`'s
  `GroupsAndGrantsTab` theo đúng cấu trúc mirror Department mà task mô tả:
  - `grantChoice` đổi từ `Record<string, string>` (chỉ department id) sang
    `Record<string, { kind: DevServerGranteeKind; id: string } | undefined>`.
  - Thêm state `teams: TenantTeam[]`, load qua `window.api.tenantProfile.listTeams?.().then(setTeams).catch(() => {})`
    song song `listDepartments()`.
  - `handleGrant` dùng `choice.kind`/`choice.id` thay vì luôn hardcode `granteeKind: 'department'`.
  - Đổi `departmentName` thành `granteeName(kind, id)` — tra `departments` hoặc `teams` tuỳ `kind`.
  - Thêm `<Select>` thứ 2 "Grant a team access" song song Select department hiện có.
  - Xoá comment cũ (dòng ~349-352 gốc: "team-based grants aren't wired up yet... BE-SOL-003") — vì
    2 lý do đã lỗi thời (`tenant-service` giờ có `ListTeamsForUser`/`ListTeams` thật) — không thay
    bằng comment placeholder mới vì UI giờ đã wire thật, chỉ còn thiếu 1 dòng bridge phía
    `web-preload-api.ts` (đã ghi chú ngay trong code bằng comment ở `useEffect`).
- Import thêm `DevServerGranteeKind` từ `dev-server-types` và `TenantTeam` từ
  `tenant-user-profile-types` ở đầu file.
- **Verify:**
  - `cd frontend && npx tsc --noEmit -p tsconfig.json` — 0 lỗi type mới; `AdminDevServerConsole.tsx`
    không xuất hiện trong danh sách lỗi (baseline lỗi cũ 147 dòng, không liên quan file này).
  - `npx vitest run src/renderer/src/components/settings/__tests__/AdminDevServerConsole.test.tsx` —
    **file test này KHÔNG TỒN TẠI** trong repo hiện tại (`find` xác nhận, không có test file nào
    cho `AdminDevServerConsole` hay `GroupsAndGrantsTab`) — lệnh verify trong task gốc trỏ tới 1 file
    chưa từng được tạo. Không có test nào để chạy/thêm mới trong phạm vi task này (không tự tạo test
    mới ngoài phạm vi mô tả, vì task không yêu cầu viết test mới).

## ⚠️ Phụ thuộc backend-go

Cùng cảnh báo với FE-TASK-011: nếu `window.api.tenantProfile.listTeams` chưa tồn tại thật ở
backend-go khi task này thực thi, `.catch(() => {})` khiến mảng `teams` rỗng — Select "Grant a team
access" hiển thị nhưng không lọc được gì (đúng bản chất P0 của gap CR-004 mô tả: hiện Team grant
vẫn rỗng cả 2 phía cho tới khi backend-go xong). Không cần chờ backend-go để merge UI này — chỉ
không "thật sự work" cho tới lúc đó. **Depends on:** backend-go's BE-TASK tương ứng của
CR-RBAC-004 (xem `specs/backend-go/crs/v4/team-rbac/tasks/`, đang soạn song song).

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/renderer/src/components/settings/AdminDevServerConsole.tsx` | MODIFY — `GroupsAndGrantsTab` |

## Các bước thực thi

Sửa `GroupsAndGrantsTab` theo cấu trúc sau (mirror hoàn toàn pattern Department hiện có):

```tsx
function GroupsAndGrantsTab(): React.JSX.Element {
  const { groups, loading, reload } = useDevServerGroups()
  const [departments, setDepartments] = useState<TenantDepartment[]>([])
  const [teams, setTeams] = useState<TenantTeam[]>([])
  const [newGroupName, setNewGroupName] = useState('')
  const [creating, setCreating] = useState(false)
  // grantChoice giờ giữ cả kind lẫn id, vì 1 group có thể grant cả department và team
  const [grantChoice, setGrantChoice] = useState<
    Record<string, { kind: DevServerGranteeKind; id: string } | undefined>
  >({})
  const [grantsByGroup, setGrantsByGroup] = useState<Record<string, DevServerGroupGrant[]>>({})

  useEffect(() => {
    window.api.tenantProfile.listDepartments().then(setDepartments).catch(() => {})
    // CR-RBAC-004: đóng gap backend-go's team-listing API — nếu API chưa tồn tại,
    // catch im lặng và để mảng rỗng, Select "team" hiển thị nhưng vô dụng
    // (không khác gì trạng thái hiện tại, chỉ rõ ràng hơn về UI).
    window.api.tenantProfile.listTeams?.().then(setTeams).catch(() => {})
  }, [])

  const handleGrant = useCallback(
    (groupId: string) => {
      const choice = grantChoice[groupId]
      if (!choice) return
      window.api.devServerGroup
        .grant({ devServerGroupId: groupId, granteeKind: choice.kind, granteeId: choice.id })
        .then(() => loadGrants(groupId))
        .catch((err) => toast.error(err instanceof Error ? err.message : String(err)))
    },
    [grantChoice, loadGrants]
  )

  const granteeName = useCallback(
    (kind: DevServerGranteeKind, id: string) =>
      kind === 'department'
        ? (departments.find((d) => d.id === id)?.name ?? id)
        : (teams.find((t) => t.id === id)?.name ?? id),
    [departments, teams]
  )

  // render: badge dùng granteeName(grant.granteeKind, grant.granteeId) thay vì
  // departmentName(...) cố định; thêm 1 <Select> thứ 2 "Grant a team access" song song
  // Select department hiện có, cùng set grantChoice[groupId] = { kind: 'team', id }.
}
```

Xoá comment cũ (dòng ~349-352) "team-based grants aren't wired up yet..." — nếu backend-go's
team-listing API chưa xong khi merge, thay bằng: "UI đã sẵn sàng, chờ backend-go's
`ListTeamsForUser`/`listTeams` — xem CR-RBAC-004".

## Verify

```bash
cd frontend && npx tsc --noEmit -p tsconfig.json
cd frontend && npx vitest run src/renderer/src/components/settings/__tests__/AdminDevServerConsole.test.tsx
```

## Depends on

FE-TASK-011 (cần `TenantTeam` type + `tenantProfile.listTeams` đã khai báo).

## Blocking

Không có.
