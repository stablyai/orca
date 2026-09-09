# FE-TASK-003: Preload type + IPC event `onAuthStateChanged` bỏ `'lead'` (dead plumbing, chỉ để hết lỗi compile)

**Domain:** team-rbac
**Solution Ref:** [FE-SOL-001](../solutions/FE-SOL-001-drop-lead-from-global-role-model.md) Bước 4
**CR:** [CR-RBAC-002](../../../../../../docs/crs/v4/team-rbac/CR-RBAC-002-unify-role-model-and-propagate-claims.md)
**Priority:** 🔴 P0
**Estimated:** 15 phút
**Status:** ✅ DONE — 2026-09-09

## Mục tiêu

`onAuthStateChanged`'s tham số `event.user.role` khai `'developer' | 'lead' | 'admin'` ở tầng
preload type. Kênh IPC này **không có emitter nào** trong `backend/src/main` (dead plumbing thời
Electron server-mode cũ, đã xác nhận bằng grep) — nhưng type vẫn phải sửa để build sạch và nhất
quán với role model 2-tier.

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/preload/api-types.ts` | MODIFY — type tham số `onAuthStateChanged` (dòng ~3414) |
| `frontend/src/renderer/src/hooks/useIpcEvents.ts` | Không cần sửa logic — chỉ tự hết lỗi type sau khi sửa file trên |

## Các bước thực thi

**File `frontend/src/preload/api-types.ts`** — sửa type `event.user.role` trong khai báo
`onAuthStateChanged`:

```typescript
// event.user.role trong onAuthStateChanged
role: 'developer' | 'admin'   // was: 'developer' | 'lead' | 'admin'
```

**File `frontend/src/renderer/src/hooks/useIpcEvents.ts`** — không sửa gì chủ động; object literal
ở đây gán thẳng `event.user.role` nên tự hết lỗi type sau thay đổi trên. Chỉ chạy `tsc` để xác
nhận không còn lỗi.

## Verify

```bash
cd frontend && npx tsc --noEmit -p tsconfig.json
grep -n "'lead'" frontend/src/preload/api-types.ts
```

## Không làm ở task này

- Không thêm/bỏ emitter thật cho kênh `auth:state-changed` — đây là dead plumbing, ngoài phạm vi
  CR-002.
- Không sửa `teams`/`projects` trên cùng event type — đó là phạm vi FE-TASK-009 (FE-SOL-002).

## Depends on

Không có (độc lập về compile — literal type riêng, không import `OrcaUserRole`). Nên làm cùng đợt
với FE-TASK-001/002 vì cùng CR-002.

## Blocking

FE-TASK-009 sửa cùng vùng type `onAuthStateChanged` ở `api-types.ts` (khác field: `teams`/
`projects`) — làm task này **trước** FE-TASK-009 để tránh 2 patch đụng cùng khối type gây conflict
khi áp dụng tuần tự.

## Kết quả thực tế (2026-09-09)

Task này thực chất là frontend (đúng như nghi vấn ở đề bài chỉ áp dụng cho FE-TASK-003 trong 1 audit
khác — file task này tự nó rõ ràng chỉ sửa `frontend/src/preload/api-types.ts`, một file
TypeScript-only, không đụng backend-go). Xác nhận lại vị trí bằng `grep -n "onAuthStateChanged" -A
15 frontend/src/preload/api-types.ts` (dòng 3404-3418) — khớp mô tả task (lệch nhẹ so với "dòng
~3414" ghi trong task, field `role` thực tế ở dòng 3414 sau khi tính cả comment — đúng số dòng ghi
trong task).

`impact()` không nhận diện `onAuthStateChanged` như 1 symbol độc lập trong type literal (nó là 1
field của `PreloadApi`, không phải hàm/class riêng) — dùng `codegraph_explore "onAuthStateChanged
api-types.ts preload"` xác nhận `PreloadApi` (frontend) có 40 caller, không có gì đặc biệt gắn riêng
với field này (dead plumbing, đúng như task ghi — không tìm thấy emitter `auth:state-changed` nào
trong `backend/src/main` qua các lần khảo sát trước).

Đã sửa field `role` trong type tham số `event.user` của `onAuthStateChanged` (dòng 3414) thành
`'developer' | 'admin'`, giữ nguyên comment `// was: ...`. Không đụng `teams`/`projects` (thuộc
FE-TASK-009, làm sau). `useIpcEvents.ts` không cần sửa gì (đúng dự đoán — object literal gán thẳng
`event.user.role`, tự hết lỗi type).

`grep -n "'lead'" frontend/src/preload/api-types.ts`: rỗng. `tsc --noEmit`: không phát sinh lỗi
mới (baseline 147 dòng không đổi). Không có gì khác biệt so với kế hoạch.
