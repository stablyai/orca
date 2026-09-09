# FE-SOL-002: Xoá selector/field chết `project`-scoping + thêm Team grant picker (mirror Department)

> 🔲 Proposed — chưa cài đặt.

## CR Reference

- **CR:** [CR-RBAC-004](../../../../../../docs/crs/v4/team-rbac/CR-RBAC-004-project-team-scoped-server-visibility.md)
- **Mức độ:** 🔴 P0
- **Phụ thuộc backend-go:** phần "Team grant thực sự lọc được server" cần backend-go đóng gap
  BE-SOL-003 (`ListTeamsForUser` expose cho `infra-fleet-service`) TRƯỚC — solution FE này chỉ làm
  phần client (xoá dead code + thêm UI + client wiring), phần UI Team-picker sẽ **hiển thị nhưng
  không lọc được gì** cho tới khi backend-go xong (đúng bản chất P0 của gap này: hiện Team grant vẫn
  rỗng cả 2 phía).

## Impact analysis (gitnexus, đã chạy lại)

| Symbol | Direction | Risk | Impacted | Ghi chú |
|---|---|---|---|---|
| `selectSshTargetsForCurrentUser` (`store/selectors.ts:265`) | upstream | LOW | **0** | Xác nhận dead code — 0 caller trong toàn repo |
| `WebRoot` (`web/main-web-bootstrap.tsx:187`) | upstream | LOW | 3 (`WebRootBoundary`→`bootstrapWebApp`→`main.tsx`) | Nơi hard-code `teams:[],projects:[]` thứ 2 — sửa nội bộ function, không đổi chữ ký nên blast radius thực tế = 0 |
| `checkSession` (`store/slices/auth.ts`) | upstream | LOW | 0 | Nơi hard-code `teams:[],projects:[]` thứ 1 |
| `UserProfileBadge` (`components/activity/UserProfileBadge.tsx`) | upstream | LOW | **0** | Component đọc `user.teams` nhưng **không ai render nó** (0 import ngoài chính nó) — an toàn xoá |
| `GroupsAndGrantsTab` (`components/settings/AdminDevServerConsole.tsx:208`) | upstream | LOW | 2 (`AdminDevServerConsole`→`Settings`) | Nơi thêm Team-grant UI |

`OrcaUser` (type alias) không phải target hợp lệ cho `impact()` (`Target 'OrcaUser' not found`,
đã thử cả `kind: TypeAlias`) — bù bằng `grep` chính xác cho `.teams`/`.projects` trên `OrcaUser`,
liệt kê đầy đủ ở "Bối cảnh" dưới.

## Bối cảnh (đã xác nhận lại — có 2 điểm khác audit gốc)

1. **`selectSshTargetsForCurrentUser` xác nhận đúng là dead code, impact = 0.** Giữ nguyên kết luận
   CR gốc: xoá an toàn.
2. **Điểm mới không có trong audit gốc: `OrcaUser.teams`/`.projects` KHÔNG hoàn toàn không có
   consumer** — ngoài `selectSshTargetsForCurrentUser` (dead), có 2 consumer khác:
   - `frontend/src/renderer/src/components/activity/UserProfileBadge.tsx` — đọc `user.teams` để
     render badge "Teams" trong dropdown. Nhưng gitnexus `impact()` xác nhận **impactedCount = 0**
     cho chính `UserProfileBadge` — không ai `import`/render nó ở đâu cả (khác hẳn
     `UserAvatarMenu.tsx`, component avatar **thật sự** đang sống, được `SidebarToolbar` render, và
     `UserAvatarMenu` chỉ đọc `user.role` qua `UserRoleBadge`, không đọc `teams`/`projects`). Kết
     luận: `UserProfileBadge.tsx` là code chết song song (không chỉ field nó đọc là chết, mà cả bản
     thân component), an toàn xoá cùng đợt.
   - `frontend/src/renderer/src/hooks/useIpcEvents.ts`'s `onAuthStateChanged` handler
     (~dòng 2945-2960) — gán `teams: event.user.teams, projects: event.user.projects` vào store.
     Nhưng `grep` xác nhận **không có bất kỳ nơi nào trong `backend/src/main` emit sự kiện IPC
     `auth:state-changed`/tương đương** — kênh này chỉ được khai báo type ở
     `frontend/src/preload/api-types.ts` và tiêu thụ ở `useIpcEvents.ts`, không có emitter nào bắn
     nó (kiểm tra `grep -rln "authStateChanged"` toàn repo, không thấy `webContents.send` liên
     quan). Đây là dead plumbing của thời Electron server-mode cũ, không phải nguồn dữ liệu thật —
     xoá field khỏi `OrcaUser` cũng an toàn ở đây, chỉ cần sửa type cho hết lỗi compile.
3. **`frontend/src/shared/rbac-types.ts`** định nghĩa `OrcaUser` riêng (trùng tên, khác namespace)
   với `teams`/`projects`/role 3-valued — `grep` xác nhận **0 file import** — dead type hoàn toàn,
   gộp xoá vào solution này (đã note ở FE-SOL-001 để tránh trùng).
4. **`GroupsAndGrantsTab`** (đã đọc verbatim qua codegraph) xác nhận đúng: chỉ có Select "Grant a
   department access" gọi `window.api.devServerGroup.grant({..., granteeKind: 'department', ...})`.
   `DevServerGranteeKind` (`frontend/src/shared/dev-server-types.ts:188`) đã là
   `'department' | 'team'` — **type layer đã sẵn sàng cho Team**, chỉ thiếu UI + 1 API để liệt kê
   teams. Không có `window.api.tenantProfile.listTeams()` hay tương đương nào tồn tại hiện nay
   (`grep` trên `api-types.ts` không ra kết quả nào khớp, chỉ có Linear's `listTeams` — không liên
   quan).

## Giải pháp

### Phần A — Xoá dead code (an toàn ngay, không phụ thuộc backend-go)

**File:** `frontend/src/renderer/src/store/selectors.ts` (MODIFY)

Xoá `selectSshTargetsForCurrentUser` (dòng 265-281) — impact xác nhận 0 dependent.

**File:** `frontend/src/renderer/src/store/slices/auth.ts` (MODIFY)

```typescript
export type OrcaUser = {
  id: string
  email: string
  name: string
  avatarUrl?: string
  role: OrcaUserRole
  // teams/projects: xoá — không nguồn nào đổ dữ liệu thật (CR-RBAC-004);
  // scoping RBAC thật là infra-fleet-service's Department/Team grant, không
  // phải field này trên OrcaUser.
}
```

Cập nhật `checkSession` — bỏ `teams: [], projects: []` khỏi object literal (~dòng 69-77).

**File:** `frontend/src/renderer/src/web/main-web-bootstrap.tsx` (MODIFY)

Cập nhật `WebRoot`'s `useEffect` (~dòng 234-242) — bỏ `teams: [], projects: []` khỏi
`store.setCurrentUser({...})`.

**File:** `frontend/src/renderer/src/hooks/useIpcEvents.ts` (MODIFY)

Cập nhật `onAuthStateChanged` handler's `store.setCurrentUser({...})` (~dòng 2945-2960) — bỏ
`teams: event.user.teams, projects: event.user.projects`. Kênh IPC này không có emitter thật, sửa
chỉ để hết lỗi compile sau khi đổi type `OrcaUser`.

**File:** `frontend/src/preload/api-types.ts` (MODIFY)

Bỏ `teams`/`projects` khỏi type tham số `event.user` của `onAuthStateChanged`.

**File:** `frontend/src/renderer/src/components/activity/UserProfileBadge.tsx` (DELETE)

Impact xác nhận impactedCount = 0 — không ai render. Xoá nguyên file (không cần deprecate dần vì
không có caller).

**File:** `frontend/src/shared/rbac-types.ts` (DELETE)

0 importer — xoá nguyên file. Nếu về sau cần khôi phục ý tưởng RBAC types dùng chung, tạo lại với
tên rõ ràng hơn (`orca-team-rbac-types.ts`) thay vì khôi phục file trùng tên với `OrcaUser` ở
`store/slices/auth.ts`.

### Phần B — Thêm Team grant picker vào `GroupsAndGrantsTab` (mirror Department)

**Điều kiện tiên quyết (backend-go, ngoài phạm vi FE):** cần 1 API liệt kê teams của tenant hiện
tại — ví dụ `window.api.tenantProfile.listTeams()` trả `TenantTeam[]` (mirror
`listDepartments(): Promise<TenantDepartment[]>` đã có), map sang `tenant-service`'s `ListTeams`
RPC (đã tồn tại theo audit — chỉ cần expose thêm 1 preload/wscompat channel, không phải RPC mới).
Nếu backend-go chưa xong, disable nút "Grant a team access" với tooltip giải thích, không ẩn hẳn
UI (để dễ thấy tiến độ khi review).

**File:** `frontend/src/shared/tenant-types.ts` (hoặc file tương đương đang khai `TenantDepartment`
— kiểm tra lại tên file thật khi cài đặt) (MODIFY)

```typescript
export type TenantTeam = {
  id: string
  name: string
}
```

**File:** `frontend/src/preload/api-types.ts` (MODIFY) — thêm vào namespace `tenantProfile`:

```typescript
/** Admin-only: lists teams in the caller's tenant (mirror listDepartments). */
listTeams: () => Promise<TenantTeam[]>
```

**File:** `frontend/src/renderer/src/components/settings/AdminDevServerConsole.tsx` (MODIFY)

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
    // CR-RBAC-004: đóng gap BE-SOL-003 — nếu API chưa tồn tại ở backend-go,
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

  // ... render: badge dùng granteeName(grant.granteeKind, grant.granteeId) thay vì
  // departmentName(...) cố định; thêm 1 <Select> thứ 2 "Grant a team access" song song
  // Select department hiện có, cùng set grantChoice[groupId] = { kind: 'team', id }.
}
```

Xoá comment cũ (dòng ~349-352) "team-based grants aren't wired up yet..." khi backend-go's
BE-SOL-003 xong; nếu FE merge trước, đổi comment thành: "UI đã sẵn sàng, chờ backend-go's
`ListTeamsForUser`/`listTeams` — xem CR-RBAC-004".

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/renderer/src/store/selectors.ts` | MODIFY — xoá `selectSshTargetsForCurrentUser` |
| `frontend/src/renderer/src/store/slices/auth.ts` | MODIFY — xoá field `teams`/`projects` trên `OrcaUser`, sửa `checkSession` |
| `frontend/src/renderer/src/web/main-web-bootstrap.tsx` | MODIFY — sửa `WebRoot`'s `useEffect` |
| `frontend/src/renderer/src/hooks/useIpcEvents.ts` | MODIFY — sửa `onAuthStateChanged` handler |
| `frontend/src/preload/api-types.ts` | MODIFY — bỏ field khỏi event type; thêm `tenantProfile.listTeams` |
| `frontend/src/renderer/src/components/activity/UserProfileBadge.tsx` | DELETE — dead component |
| `frontend/src/shared/rbac-types.ts` | DELETE — dead type, 0 importer |
| `frontend/src/shared/tenant-types.ts` (hoặc file tương đương) | MODIFY — thêm `TenantTeam` |
| `frontend/src/renderer/src/components/settings/AdminDevServerConsole.tsx` | MODIFY — `GroupsAndGrantsTab` thêm nhánh Team |
| `docs/features/F32-team-rbac.md` | MODIFY (tài liệu) — scoping axis là Team/Department, không phải Project |

## Verification (khi cài đặt)

```bash
cd frontend && npx tsc --noEmit -p tsconfig.json
cd frontend && npx vitest run src/renderer/src/store/__tests__/selectors.test.ts
cd frontend && npx vitest run src/renderer/src/components/settings/__tests__/AdminDevServerConsole.test.tsx
```

## Không làm ở solution này

- Implement `ListTeamsForUser` RPC/wiring thật ở backend-go (`infra-fleet-service`/`tenant-service`)
  — đó là backend-go's BE-SOL-003 follow-up của CR-RBAC-004.
- Thêm trục scoping "Project" mới cho server visibility — CR-004 xác nhận quyết định kiến trúc là
  Team/Department, không mở thêm trục.
- Sửa `infra-fleet-service`'s `ListDevServersForUser` để đọc `team_ids` thật — backend-go.
